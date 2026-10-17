/**
 * One tax invoice per lease rental (slice 3, C4; DESIGN D7).
 *
 * TIME OF SUPPLY. A rental is invoiced on the EARLIER of its due date and the
 * day a payment towards it is received:
 *   - the daily cron (app/api/cron/asset-finance-lease-invoices) invoices every
 *     rental whose due date has arrived, supply date = the due date;
 *   - the receipt paths (manual, bank sync, portal) call
 *     issueLeaseInvoicesOnReceipt, which invoices a rental money has reached
 *     before its due date, supply date = the day the cash first reached it
 *     (./lease-supply-date.ts).
 * Signed off (DESIGN D7; see DESIGN.md sign-off record 2026-10-17): the
 * time-of-supply rule for rentals (VAT Act s9(3)(a) as we read it: the earlier
 * of the payment becoming due and its receipt).
 *
 * LINES. The rental and, on a full-maintenance lease, the maintenance, each a
 * standard-rated line priced ex VAT; VAT half-up per line, exactly as the
 * rental was priced (./lease-pricing.ts), so the invoice total is the
 * LeaseRental's total (asserted; guardLeaseRental checks it too).
 *
 * EXACTLY ONCE. The rental row is locked FOR UPDATE first: a concurrent issuer
 * waits and then finds the invoice (already_invoiced). The unique index on
 * LeaseRental.taxInvoiceId is the backstop.
 *
 * VAT Act s67: supply-date VAT is recomputed before linking the invoice; the
 * rental, repayment schedule and loan totals change in that same transaction.
 */
import { Prisma, type ContractType } from "@prisma/client"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { describeAsset, issueTaxInvoice, type TaxInvoiceDb } from "@/lib/vat/tax-invoice"
import { loadRateOn, rateTenThousandthsOf } from "@/lib/vat/vat-rate"
import type { VatTransaction } from "@/lib/vat/db"
import { recipientAddress } from "./booking-load"
import { completeEndOfTermIfSettled } from "./lease-end-invoice"
import { dbDate, isoOfDbDate } from "./dates"
import { vatOnExclusive } from "@/lib/vat/amounts"
import { refreshLoan } from "./lease-charges"
import type { SigningTx } from "./signing-prepare"
import { replayLeaseCancellationCredit, LEASE_SUPPLY_VAT_CREDIT } from "./lease-credit-replay"
import { cashReachedOn } from "./lease-supply-date"

export type LeaseInvoiceTx = TaxInvoiceDb & Pick<VatTransaction, "$queryRaw" | "leaseRental" | "auditLog" | "maintenanceFund" | "maintenanceFundMovement" | "leaseEndOfTerm" | "financedAsset" | "loan" | "repaymentSchedule">

export type IssueRentalResult =
  | { kind: "issued"; invoiceId: string; invoiceNumber: string; vatAdjusted?: boolean }
  | { kind: "already_invoiced"; invoiceId: string }
  | { kind: "not_found" }
  | { kind: "refused"; reason: string; error: string }

const RENTAL_SELECT = {
  id: true, periodNo: true, dueDate: true, rentalExclVatCents: true, maintenanceExclVatCents: true,
  vatRate: true, totalCents: true, taxInvoiceId: true, loanId: true, cancelledAt: true,
  loan: {
    select: {
      reference: true, contractType: true, _count: { select: { leaseRentals: true } },
      entity: { select: { legalName: true, vatNumber: true, addressLine1: true, addressLine2: true, city: true, province: true, postalCode: true } },
      client: { select: { firstName: true, lastName: true, addressLine1: true, city: true, province: true, postalCode: true } },
      asset: { select: { make: true, model: true, year: true, serialNumber: true, vin: true } },
    },
  },
} as const satisfies Prisma.LeaseRentalSelect

export async function issueLeaseRentalInvoice(
  tx: LeaseInvoiceTx,
  input: { tenantId: string; rentalId: string; supplyDate: string; today: string; createdById: string | null; source: "cron" | "receipt" | "staff" },
): Promise<IssueRentalResult> {
  const { tenantId } = input
  const locked = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id" FROM "LeaseRental" WHERE "id" = ${input.rentalId} AND "tenantId" = ${tenantId} FOR UPDATE
  `)
  if (locked.length === 0) return { kind: "not_found" }
  const rental = await tx.leaseRental.findFirst({ where: { id: input.rentalId, tenantId }, select: RENTAL_SELECT })
  if (!rental) return { kind: "not_found" }
  if (rental.taxInvoiceId) return { kind: "already_invoiced", invoiceId: rental.taxInvoiceId }
  if (rental.cancelledAt) return { kind: "refused", reason: "cancelled", error: "The rental was cancelled by an early termination" }
  const dueDate = isoOfDbDate(rental.dueDate)
  if (input.supplyDate > dueDate || input.supplyDate > input.today) {
    return { kind: "refused", reason: "supply_date", error: `A rental's supply date is the earlier of its due date ${dueDate} and the receipt, and not after today` }
  }
  const { loan } = rental
  const lessee = loan.entity ?? loan.client
  const address = lessee ? recipientAddress(lessee) : null
  if (!lessee || !address || !loan.asset) return { kind: "refused", reason: "recipient", error: "The lessee's name and address and the asset are needed on the tax invoice" }
  const vat = await loadRateOn(tx, input.supplyDate)
  const vatChanged = vat.rateTenThousandths !== rateTenThousandthsOf(rental.vatRate)
  const supplyVatCents = vatOnExclusive(rental.rentalExclVatCents, vat.rateTenThousandths) + vatOnExclusive(rental.maintenanceExclVatCents, vat.rateTenThousandths)
  const supplyTotalCents = rental.rentalExclVatCents + rental.maintenanceExclVatCents + supplyVatCents
  const period = `rental ${rental.periodNo} of ${loan._count.leaseRentals}, due ${dueDate}`
  const lines = [
    { description: `Lease ${loan.reference}, ${period}: ${describeAsset(loan.asset)}`, quantity: 1, unitExclVatCents: rental.rentalExclVatCents },
    ...(rental.maintenanceExclVatCents > 0
      ? [{ description: `Maintenance, lease ${loan.reference}, ${period}`, quantity: 1, unitExclVatCents: rental.maintenanceExclVatCents }]
      : []),
  ]
  const name = loan.entity?.legalName ?? `${loan.client?.firstName ?? ""} ${loan.client?.lastName ?? ""}`.trim()
  const invoice = await issueTaxInvoice(tx, {
    tenantId, loanId: rental.loanId, issueDate: input.today, supplyDate: input.supplyDate,
    recipient: { name, address, vatNumber: loan.entity?.vatNumber ?? null }, lines, createdById: input.createdById,
  })
  if (invoice.totalInclVatCents !== supplyTotalCents) {
    throw new Error(`tax invoice ${invoice.invoiceNumber}: total ${invoice.totalInclVatCents} is not rental ${rental.periodNo}'s ${rental.totalCents}`)
  }
  if (vatChanged) {
    await tx.$queryRaw`SELECT set_config('credaflow.lease_vat_supply', 'on', true)`
    const delta = supplyTotalCents - rental.totalCents
    await tx.repaymentSchedule.updateMany({ where: { tenantId, leaseRental: { id: rental.id } }, data: { principalDue: { increment: delta }, totalDue: { increment: delta } } })
  }
  const bound = await tx.leaseRental.updateMany({ where: { id: rental.id, tenantId, taxInvoiceId: null }, data: { taxInvoiceId: invoice.id, ...(vatChanged ? { vatRate: vat.rate, vatCents: supplyVatCents, totalCents: supplyTotalCents } : {}) } })
  if (bound.count !== 1) throw new Error(`lease rental ${rental.id} was invoiced concurrently`)
  if (vatChanged) {
    await refreshLoan(tx as SigningTx, tenantId, rental.loanId, supplyTotalCents - rental.totalCents, input.createdById, "supply_date_vat_change")
    await replayLeaseCancellationCredit(tx as SigningTx, { tenantId, loanId: rental.loanId, userId: input.createdById, reference: invoice.id, creditReason: LEASE_SUPPLY_VAT_CREDIT, source: "supply_date_vat_change", reconcileStatus: true })
  }
  // A full-maintenance rental funds the maintenance fund as it is invoiced (./maintenance-fund.ts).
  if (rental.maintenanceExclVatCents > 0) {
    const fund = await tx.maintenanceFund.findFirst({ where: { tenantId, loanId: rental.loanId }, select: { id: true } })
    if (!fund) throw new Error(`lease ${rental.loanId} has maintenance but no maintenance fund`)
    await tx.maintenanceFundMovement.create({
      data: { tenantId, fundId: fund.id, kind: "CONTRIBUTION", amountCents: rental.maintenanceExclVatCents, leaseRentalId: rental.id,
        occurredOn: dbDate(input.supplyDate), createdById: input.createdById },
    })
  }
  await logAuditStrict({
    tenantId, userId: input.createdById ?? undefined, action: AuditAction.LEASE_RENTAL_INVOICED, entity: "LeaseRental", entityId: rental.id,
    newValue: {
      loanId: rental.loanId, periodNo: rental.periodNo, dueDate, supplyDate: input.supplyDate, source: input.source,
      taxInvoiceId: invoice.id, invoiceNumber: invoice.invoiceNumber, totalCents: rental.totalCents,
    },
  }, tx)
  if (vatChanged && input.source !== "receipt") await issueLeaseInvoicesOnReceipt(tx as LeaseInvoiceTx & Pick<VatTransaction, "repaymentSchedule" | "payment">, { tenantId, loanId: rental.loanId, contractType: loan.contractType, today: input.today, createdById: input.createdById })
  return { kind: "issued", invoiceId: invoice.id, invoiceNumber: invoice.invoiceNumber, ...(vatChanged ? { vatAdjusted: true } : {}) }
}

/**
 * The receipt-path hook: every uninvoiced rental of this lease that money has
 * reached is invoiced now, supply date = the day the cash first reached it
 * (./lease-supply-date.ts), whatever order the receipts were captured in; one
 * already due is invoiced on its due date at the latest (the cron may not have
 * run yet). Does nothing for any other contract type.
 *
 * A receipt is never refused or rolled back for its invoice: each rental is
 * invoiced inside its own SAVEPOINT, and a refusal or error is rolled back to
 * it and audited once (LEASE_INVOICE_REFUSED), leaving the rental for the
 * cron and staff. The money is recorded either way.
 */
export async function issueLeaseInvoicesOnReceipt(
  tx: LeaseInvoiceTx & Pick<VatTransaction, "repaymentSchedule" | "payment">,
  input: { tenantId: string; loanId: string; contractType: ContractType | null | undefined; today: string; createdById: string | null },
): Promise<void> {
  if (input.contractType !== "OPERATING_LEASE" && input.contractType !== "FULL_MAINTENANCE_LEASE") return
  const rentals = await tx.leaseRental.findMany({
    where: { tenantId: input.tenantId, loanId: input.loanId, taxInvoiceId: null, cancelledAt: null, schedule: { totalPaid: { gt: 0 } } },
    orderBy: { periodNo: "asc" },
    select: { id: true, dueDate: true, periodNo: true },
  })
  const seen = new Set(rentals.map(rental => rental.id))
  for (const rental of rentals) {
    const due = isoOfDbDate(rental.dueDate)
    // The earliest day the cash reached the rental (./lease-supply-date.ts), never later than its due date.
    const reached = await cashReachedOn(tx, { tenantId: input.tenantId, loanId: input.loanId, periodNo: rental.periodNo })
    if (reached === null && due > input.today) continue // not reached and not yet due: nothing supplied
    const supplyDate = reached !== null && reached < due ? reached : due
    await tx.$executeRawUnsafe("SAVEPOINT lease_rental_invoice")
    let allocationChanged = false
    let refusal: { reason: string; error: string } | null = null
    try {
      const result = await issueLeaseRentalInvoice(tx, {
        tenantId: input.tenantId, rentalId: rental.id, supplyDate: supplyDate > input.today ? input.today : supplyDate,
        today: input.today, createdById: input.createdById, source: "receipt",
      })
      allocationChanged = result.kind === "issued" && result.vatAdjusted === true
      if (result.kind === "refused") refusal = { reason: result.reason, error: result.error }
    } catch (error) {
      refusal = { reason: "invoice_error", error: error instanceof Error ? error.name : "unknown" }
    }
    if (refusal === null) {
      // The invoice's deferred checks run inside the savepoint, so a failure is rolled back with it, never with the receipt.
      try {
        await tx.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE")
        await tx.$executeRawUnsafe("SET CONSTRAINTS ALL DEFERRED")
        if (allocationChanged) {
          const reached = await tx.leaseRental.findMany({ where: { tenantId: input.tenantId, loanId: input.loanId, taxInvoiceId: null, cancelledAt: null, schedule: { totalPaid: { gt: 0 } } }, orderBy: { periodNo: "asc" }, select: { id: true, dueDate: true, periodNo: true } })
          for (const next of reached) if (!seen.has(next.id)) { seen.add(next.id); rentals.push(next) }
        }
        await tx.$executeRawUnsafe("RELEASE SAVEPOINT lease_rental_invoice")
        continue
      } catch (error) {
        refusal = { reason: "invoice_error", error: error instanceof Error ? error.name : "unknown" }
      }
    }
    await tx.$executeRawUnsafe("ROLLBACK TO SAVEPOINT lease_rental_invoice")
    const already = await tx.auditLog.findFirst({
      where: { tenantId: input.tenantId, action: AuditAction.LEASE_INVOICE_REFUSED, entity: "LeaseRental", entityId: rental.id },
      select: { id: true },
    })
    if (!already) {
      await logAuditStrict({
        tenantId: input.tenantId, userId: input.createdById ?? undefined, action: AuditAction.LEASE_INVOICE_REFUSED,
        entity: "LeaseRental", entityId: rental.id, newValue: { ...refusal, source: "receipt" },
      }, tx)
    }
  }
  // A receipt that settles an invoiced end of term closes the lease (./lease-end-invoice.ts).
  await completeEndOfTermIfSettled(tx, { tenantId: input.tenantId, loanId: input.loanId, userId: input.createdById })
}
