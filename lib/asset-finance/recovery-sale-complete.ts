import { AuditAction, logAuditStrict } from "@/lib/audit"
import { sastCalendarDate } from "@/lib/date/sast"
import { prisma } from "@/lib/prisma"
import { describeAsset, issueTaxInvoice, VatNotConfiguredError } from "@/lib/vat/tax-invoice"
import { loadRateOn, NoVatRateError } from "@/lib/vat/vat-rate"
import { dbDate, isoOfDbDate, toDayNumber } from "./dates"
import type { RecoveryActor } from "./recovery-create"
import { advance, RecoveryRefusal, refusable, type NotFound, type NotReady } from "./recovery-result"
import { approvalRequired } from "./recovery-sale"
import { repossessionVatEvent, type RecoveryContractType } from "./recovery-vat"
import type { SigningTx } from "./signing-prepare"

export interface CompleteSaleInput { completedOn: string }
export type SaleCompleted = { kind: "done"; id: string; taxInvoiceId: string; invoiceNumber: string; vatEvent: "REPOSSESSION_DEEMED_SUPPLY" | "LESSOR_RESALE" }

// Completing a sale is one transaction: the buyer's tax invoice (loanId null,
// the buyer as recipient, one line describing the asset), the recovery's VAT
// event, the sale COMPLETED and the recovery LISTED -> SOLD. The asset's
// SOLD_IN_REMARKETING status follows from the sale (syncSaleAssetStatus).
//
// VAT event, per the deal type (recovery-vat.ts):
//  - instalment sale / finance lease: the debtor's deemed supply at repossession
//    (s8(10)). Dated and rated on the repossession date. The unpaid cash price is
//    the loan's outstanding principal when the sale completes (proceeds are applied
//    after, so this is the balance of the amount financed the debtor still owed at
//    repossession, less any instalment paid since), capped at the cash price
//    including VAT. The lender claims the input tax; the debtor is a vendor when
//    its business entity holds a VAT number (a natural person has none on file).
//    The lender's output tax on the resale is on the buyer's invoice, so this
//    event carries no output tax.
//  - operating / full-maintenance lease: the lessor's resale; output tax is the
//    VAT on the invoice, no deemed supply, no input tax.
// UNTESTED: tax | the unpaid-cash-price proxy and the dating need the tax adviser's sign-off.

async function lockRecovery(tx: SigningTx, id: string): Promise<void> {
  await tx.$queryRaw`SELECT 1 FROM "Recovery" WHERE id = ${id} FOR UPDATE`
}

export async function completeSale(actor: RecoveryActor, recoveryId: string, saleId: string, input: CompleteSaleInput): Promise<NotFound | NotReady | SaleCompleted> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.completedOn)) return { kind: "not_ready", reason: "Provide the completion date as YYYY-MM-DD" }
  return refusable(() => prisma.$transaction(async (tx): Promise<NotFound | SaleCompleted> => {
    const head = await tx.remarketingSale.findFirst({ where: { id: saleId, recoveryId, tenantId: actor.tenantId }, select: { recoveryId: true } })
    if (!head) return { kind: "not_found" }
    await lockRecovery(tx, head.recoveryId)
    const sale = await tx.remarketingSale.findFirst({
      where: { id: saleId, tenantId: actor.tenantId },
      include: { recovery: { include: { asset: true, loan: { select: { contractType: true, outstandingPrincipal: true, entity: { select: { vatNumber: true } } } } } } },
    })
    if (!sale) return { kind: "not_found" }
    const { recovery } = sale
    if (sale.status !== "PENDING_APPROVAL") throw new RecoveryRefusal(`The sale is already ${sale.status.toLowerCase()}`)
    if (recovery.status !== "LISTED") throw new RecoveryRefusal("A sale completes on a listed recovery")
    const today = sastCalendarDate(new Date())
    if (toDayNumber(input.completedOn) > toDayNumber(today)) throw new RecoveryRefusal("The sale cannot be completed on a future date")
    if (toDayNumber(input.completedOn) < toDayNumber(isoOfDbDate(recovery.recoveredOn))) throw new RecoveryRefusal("The sale cannot be dated before the recovery")
    if (approvalRequired(sale) && (!sale.approvedById || sale.approvedById === sale.createdById)) {
      throw new RecoveryRefusal("A sale under the valuation, or to a screened party, is approved by someone other than the person who proposed it")
    }
    const contractType = recovery.loan.contractType as RecoveryContractType

    let invoice
    try {
      invoice = await issueTaxInvoice(tx, {
        tenantId: actor.tenantId, loanId: null, issueDate: input.completedOn, supplyDate: input.completedOn,
        recipient: { name: sale.buyerName, address: sale.buyerAddress, vatNumber: sale.buyerVatNumber },
        lines: [{ description: describeAsset(recovery.asset), inclVatCents: sale.priceInclVatCents }],
        createdById: actor.userId,
      })
    } catch (error) {
      if (error instanceof VatNotConfiguredError || error instanceof NoVatRateError) throw new RecoveryRefusal(error.message)
      throw error
    }

    const resale = contractType === "OPERATING_LEASE" || contractType === "FULL_MAINTENANCE_LEASE"
    const eventDate = resale ? input.completedOn : isoOfDbDate(recovery.recoveredOn)
    const rate = await loadRateOn(tx, eventDate)
    const vat = repossessionVatEvent({
      contractType, debtorVatVendor: !!recovery.loan.entity?.vatNumber, vatRateTenThousandths: rate.rateTenThousandths,
      unpaidCashPriceCents: recovery.loan.outstandingPrincipal, cashPriceInclVatCents: recovery.asset.cashPriceExclVatCents + recovery.asset.vatCents,
    })
    const debtorVatNumber = recovery.loan.entity?.vatNumber ?? null
    await tx.remarketingSale.update({
      where: { id: sale.id, tenantId: actor.tenantId },
      data: { status: "COMPLETED", completedAt: new Date(), taxInvoiceId: invoice.id },
    })
    await advance(tx, actor, recovery.id, "LISTED", { status: "SOLD" })
    const event = await tx.recoveryVatEvent.create({ data: {
      tenantId: actor.tenantId, recoveryId: recovery.id, kind: vat.kind, eventDate: dbDate(eventDate), dealContractType: contractType,
      debtorVatVendor: !!debtorVatNumber, debtorVatNumber, deemedSupplyValueCents: vat.deemedSupplyValueCents,
      inputTaxClaimCents: vat.inputTaxClaimCents, outputTaxCents: resale ? invoice.vatCents : 0,
      vatRateTenThousandths: rate.rateTenThousandths, basis: vat.basis, recordedById: actor.userId,
    } })
    const audit = { tenantId: actor.tenantId, userId: actor.userId, userEmail: actor.userEmail ?? undefined }
    await logAuditStrict({
      ...audit, action: AuditAction.ASSET_REMARKETING_SALE_COMPLETED, entity: "RemarketingSale", entityId: sale.id,
      newValue: { recoveryId: recovery.id, taxInvoiceId: invoice.id, invoiceNumber: invoice.invoiceNumber, priceInclVatCents: sale.priceInclVatCents, completedOn: input.completedOn },
    }, tx)
    await logAuditStrict({
      ...audit, action: AuditAction.ASSET_RECOVERY_VAT_EVENT_RECORDED, entity: "Recovery", entityId: recovery.id,
      newValue: { vatEventId: event.id, kind: vat.kind, eventDate, deemedSupplyValueCents: vat.deemedSupplyValueCents, inputTaxClaimCents: vat.inputTaxClaimCents, outputTaxCents: event.outputTaxCents },
    }, tx)
    return { kind: "done", id: sale.id, taxInvoiceId: invoice.id, invoiceNumber: invoice.invoiceNumber, vatEvent: vat.kind }
  }))
}
