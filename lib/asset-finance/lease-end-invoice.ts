/**
 * Billing and closing a lease's end of term (slice 3, C7–C8), in the caller's
 * transaction (./lease-end-of-term.ts elects and inspects).
 *
 * invoiceEndOfTerm — one tax invoice, supply date today, a line each:
 *   RETURN / EXTEND (after the inspection):
 *     excess usage   (final − start − allowance × months/12) × rate, ex VAT (./lease-usage.ts);
 *                    the months are the rentals the lease actually ran (an
 *                    extension adds, an early termination ends them)
 *     damage         each assessed item
 *   PURCHASE: the sale of the asset at the elected price (market value)
 *   all outcomes, full-maintenance: the fund is settled (./maintenance-fund.ts):
 *     LESSEE_SETTLED deficit → a line; surplus → a recorded refund
 *     (SETTLEMENT_REFUND; the money moves outside CredaFlow, as payouts do);
 *     LENDER_RISK → reported only (settledBalanceCents).
 * The invoice total becomes a schedule row (./lease-charges.ts), due in
 * END_OF_TERM_PAYMENT_DAYS, so receipts collect it. A returned asset is
 * RETURNED_TO_STOCK (ready for slice-4 remarketing). Nothing to bill: no invoice.
 * VAT on excess usage, damage and the fund deficit: signed off (see DESIGN.md sign-off record 2026-10-17).
 *
 * completeEndOfTermIfSettled — once nothing is owed (and a purchased
 * registered vehicle's eNaTIS change is confirmed) the end of term is
 * COMPLETED and the loan closed; a purchased asset is SOLD_TO_LESSEE. Called
 * after invoicing, from the receipt paths, and when the eNaTIS change is confirmed.
 */
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { sastCalendarDate } from "@/lib/date/sast"
import { describeAsset, issueTaxInvoice } from "@/lib/vat/tax-invoice"
import { recipientAddress } from "./booking-load"
import { dbDate, fromDayNumber, isoOfDbDate, toDayNumber } from "./dates"
import { appendLeaseCharge } from "./lease-charges"
import { excessUsage } from "./lease-usage"
import { fundBalance, fundSettlement } from "./maintenance-fund"
import type { SigningTx } from "./signing-prepare"
import type { EndResult } from "./lease-end-of-term"
import { billingRefusal } from "./lease-end-billing"
import { END_OF_TERM_PAYMENT_DAYS } from "./lease-periods"

export { END_OF_TERM_PAYMENT_DAYS }

const refused = (reason: string, error: string): EndResult => ({ kind: "refused", reason, error })

interface FundToSettle {
  fundId: string
  balanceCents: number
  billCents: number
  settlement: ReturnType<typeof fundSettlement>
}

/** The fund's settlement (./maintenance-fund.ts), written after the invoice: the refund or billed deficit movement, then the fund settled. */
async function prepareFundSettlement(tx: SigningTx, tenantId: string, loanId: string): Promise<FundToSettle | null> {
  // Lock the fund: a claim paid concurrently waits, then finds the fund settled (guardMaintenanceFundMovement).
  await tx.$queryRaw`SELECT "id" FROM "MaintenanceFund" WHERE "tenantId" = ${tenantId} AND "loanId" = ${loanId} FOR UPDATE`
  const fund = await tx.maintenanceFund.findFirst({ where: { tenantId, loanId }, select: { id: true, riskModel: true, settledAt: true, movements: { select: { kind: true, amountCents: true } } } })
  if (!fund || fund.settledAt) return null
  const balanceCents = fundBalance(fund.movements)
  const settlement = fundSettlement(fund.riskModel, balanceCents)
  return { fundId: fund.id, balanceCents, billCents: settlement.kind === "BILL" ? settlement.amountCents : 0, settlement }
}

/** Marks the fund settled (once; guardMaintenanceFund), after any settlement movement. */
async function markFundSettled(tx: SigningTx, tenantId: string, loanId: string, fund: FundToSettle, userId: string): Promise<void> {
  await tx.maintenanceFund.update({ where: { id: fund.fundId, tenantId }, data: { settledAt: new Date(), settledBalanceCents: fund.balanceCents, settledById: userId } })
  await logAuditStrict({ tenantId, userId, action: AuditAction.MAINTENANCE_FUND_SETTLED, entity: "MaintenanceFund", entityId: fund.fundId, newValue: { loanId, balanceCents: fund.balanceCents, settlement: fund.settlement } }, tx)
}

export interface ActualFundRefund { amountCents: number; paidOn: string; reference: string; documentId: string }

export async function invoiceEndOfTerm(tx: SigningTx, actor: { tenantId: string; userId: string }, input: { loanId: string; today: string; refund?: ActualFundRefund }): Promise<EndResult> {
  const { tenantId } = actor
  // Lock the end of term: a concurrent re-base waits, so the sale is invoiced at the price the row keeps.
  await tx.$queryRaw`SELECT "id" FROM "LeaseEndOfTerm" WHERE "loanId" = ${input.loanId} AND "tenantId" = ${tenantId} FOR UPDATE`
  const row = await tx.leaseEndOfTerm.findFirst({
    where: { tenantId, loanId: input.loanId },
    include: {
      damageItems: true, finalReading: true,
      loan: {
        select: {
          reference: true, assetId: true, startDate: true,
          entity: { select: { legalName: true, vatNumber: true, addressLine1: true, addressLine2: true, city: true, province: true, postalCode: true } },
          client: { select: { firstName: true, lastName: true, addressLine1: true, city: true, province: true, postalCode: true } },
          asset: { select: { make: true, model: true, year: true, serialNumber: true, vin: true } },
          assetFinanceDeal: { select: { usageAllowancePerYear: true, excessRateCents: true, usageUnit: true } },
          _count: { select: { leaseRentals: { where: { cancelledAt: null } } } },
        },
      },
    },
  })
  const asset = row?.loan.asset
  const assetId = row?.loan.assetId
  if (!row || !asset || !assetId) return { kind: "not_found" }
  const purchase = row.outcome === "PURCHASE"
  const totalLoss = row.outcome === "TOTAL_LOSS"
  if (purchase || totalLoss ? row.status !== "ELECTED" : row.status !== "INSPECTED") return refused("not_ready", `The end of term is ${row.status}: ${purchase ? "elect" : "inspect"} first`)
  const { loan } = row
  const refusal = await billingRefusal(tx, { tenantId, loanId: input.loanId, today: input.today, actorUserId: actor.userId, row: { ...row, assetId } })
  if (refusal) return refusal
  const lessee = loan.entity ?? loan.client
  const address = lessee ? recipientAddress(lessee) : null
  if (!lessee || !address) return refused("recipient", "The lessee's name and address are needed on the tax invoice")
  const lines: { description: string; quantity: number; unitExclVatCents: number }[] = []
  let excessUsageCents: number | null = null
  const deal = loan.assetFinanceDeal
  const usageContracted = !purchase && !totalLoss && !!deal?.usageAllowancePerYear && !!deal.excessRateCents && !!deal.usageUnit
  // Fail closed: contracted usage is billed from the final reading, never skipped for want of one.
  if (usageContracted && !row.finalReading) return refused("final_reading", "Record the final meter reading at the inspection first")
  if (usageContracted && deal?.usageAllowancePerYear && deal.excessRateCents && deal.usageUnit && row.finalReading) {
    const start = await tx.assetMeterReading.findFirst({ where: { tenantId, loanId: input.loanId, unit: deal.usageUnit }, orderBy: [{ readingDate: "asc" }, { value: "asc" }], select: { value: true } })
    if (!start) return refused("start_reading", "The lease has no start reading")
    const usage = excessUsage({ startReading: start.value, finalReading: row.finalReading.value, allowancePerYear: deal.usageAllowancePerYear, termMonths: loan._count.leaseRentals, excessRateCents: deal.excessRateCents })
    excessUsageCents = usage.excessCents
    if (usage.excessCents > 0) {
      const unit = deal.usageUnit === "HOURS" ? "hours" : "km"
      lines.push({ description: `Excess usage: ${(usage.excessTwelfths / 12).toFixed(2)} ${unit} above the contracted ${deal.usageAllowancePerYear} ${unit} a year`, quantity: 1, unitExclVatCents: usage.excessCents })
    }
  }
  for (const item of totalLoss ? [] : row.damageItems) lines.push({ description: `Damage: ${item.description}`, quantity: 1, unitExclVatCents: item.amountExclVatCents })
  if (purchase && row.purchasePriceExclVatCents) lines.push({ description: `Sale of ${describeAsset(asset)}`, quantity: 1, unitExclVatCents: row.purchasePriceExclVatCents })
  const fund = await prepareFundSettlement(tx, tenantId, input.loanId)
  let actualRefund: ActualFundRefund | null = null
  if (totalLoss && fund?.settlement.kind === "REFUND") {
    const proof = input.refund
    if (!proof || proof.amountCents !== fund.settlement.amountCents || !Number.isSafeInteger(proof.amountCents)
      || typeof proof.reference !== "string" || !proof.reference.trim() || proof.reference.trim().length > 120
      || typeof proof.documentId !== "string" || !proof.documentId.trim()) return refused("refund_evidence", "Record the actual maintenance-fund refund: exact amount, payment date, bank reference and retained proof")
    try { toDayNumber(proof.paidOn) } catch { return refused("refund_evidence", "Record a valid actual refund date") }
    const loss = await tx.leaseTerminationQuote.findFirst({ where: { tenantId, loanId: input.loanId, totalLoss: true, status: "ACCEPTED" }, select: { terminationDate: true } })
    if (!loss || proof.paidOn < isoOfDbDate(loss.terminationDate) || proof.paidOn > input.today) return refused("refund_evidence", "The actual refund date must be between the loss and today")
    const document = await tx.entityDocument.findFirst({ where: { id: proof.documentId, tenantId, deletedAt: null, uploadedByType: "staff", fileSize: { gt: 0 }, deal: { loanId: input.loanId, tenantId } }, select: { id: true } })
    if (!document) return refused("refund_evidence", "Use retained staff-uploaded refund proof from this lease's deal")
    const reference = proof.reference.trim().toUpperCase()
    const reused = await tx.maintenanceFundMovement.findFirst({ where: { tenantId, OR: [{ refundReference: reference }, { refundDocumentId: document.id }] }, select: { id: true } })
    if (reused) return refused("refund_evidence", "This refund bank reference or proof was already recorded")
    actualRefund = { ...proof, reference }
  }
  if (fund && fund.billCents > 0) lines.push({ description: "Maintenance fund deficit settled by the lessee", quantity: 1, unitExclVatCents: fund.billCents })

  let taxInvoiceId: string | null = null
  let scheduleId: string | null = null
  if (lines.length > 0) {
    const name = loan.entity?.legalName ?? `${loan.client?.firstName ?? ""} ${loan.client?.lastName ?? ""}`.trim()
    const invoice = await issueTaxInvoice(tx, {
      tenantId, loanId: input.loanId, issueDate: input.today, supplyDate: input.today, createdById: actor.userId,
      recipient: { name, address, vatNumber: loan.entity?.vatNumber ?? null }, lines,
    })
    taxInvoiceId = invoice.id
    if (fund && fund.billCents > 0) {
      await tx.maintenanceFundMovement.create({ data: { tenantId, fundId: fund.fundId, kind: "SETTLEMENT_BILLED", amountCents: fund.billCents, taxInvoiceId: invoice.id, occurredOn: dbDate(input.today), createdById: actor.userId } })
    }
    scheduleId = await appendLeaseCharge(tx, {
      tenantId, loanId: input.loanId, amountCents: invoice.totalInclVatCents, actorUserId: actor.userId,
      dueDate: fromDayNumber(toDayNumber(input.today) + END_OF_TERM_PAYMENT_DAYS), why: "lease_end_of_term_invoice",
    })
  }
  if (fund && fund.settlement.kind === "REFUND") {
    await tx.maintenanceFundMovement.create({ data: { tenantId, fundId: fund.fundId, kind: "SETTLEMENT_REFUND", amountCents: fund.settlement.amountCents, occurredOn: dbDate(actualRefund?.paidOn ?? input.today), createdById: actor.userId, refundDocumentId: actualRefund?.documentId, refundReference: actualRefund?.reference, note: actualRefund ? `Actual external maintenance refund evidenced: ${actualRefund.reference}` : "Surplus refunded to the lessee (paid outside CredaFlow)" } })
  }
  if (fund) await markFundSettled(tx, tenantId, input.loanId, fund, actor.userId)
  await tx.leaseEndOfTerm.update({ where: { id: row.id, tenantId }, data: { status: "INVOICED", taxInvoiceId, scheduleId, excessUsageCents, fundSettlementCents: fund?.billCents ?? null } })
  if (!purchase && !totalLoss) await tx.financedAsset.update({ where: { id: assetId, tenantId }, data: { lessorStatus: "RETURNED_TO_STOCK", lessorStatusAt: new Date() } })
  await logAuditStrict({
    tenantId, userId: actor.userId, action: totalLoss ? AuditAction.LEASE_TOTAL_LOSS_BILLED : purchase ? AuditAction.LEASE_PURCHASED : AuditAction.LEASE_RETURNED, entity: "LeaseEndOfTerm", entityId: row.id,
    newValue: { loanId: input.loanId, outcome: row.outcome, taxInvoiceId, scheduleId, excessUsageCents, lines, ...(actualRefund ? { actualRefund } : {}) },
  }, tx)
  await completeEndOfTermIfSettled(tx, { tenantId, loanId: input.loanId, userId: actor.userId })
  return { kind: "ok", endOfTermId: row.id, status: "INVOICED" }
}

/** Closes an invoiced end of term once nothing is owed (and a purchased registered vehicle's eNaTIS change is confirmed). */
/** What closing needs: the receipt paths pass their own transaction (./lease-invoices.ts). */
export type CompleteEndTx = Pick<SigningTx, "leaseEndOfTerm" | "financedAsset" | "loan" | "auditLog">

export async function completeEndOfTermIfSettled(tx: CompleteEndTx, input: { tenantId: string; loanId: string; userId: string | null }): Promise<boolean> {
  const { tenantId, loanId } = input
  const row = await tx.leaseEndOfTerm.findFirst({
    where: { tenantId, loanId, status: "INVOICED" },
    select: { id: true, outcome: true, natisTransferConfirmedAt: true, loan: { select: { status: true, assetId: true, asset: { select: { registrationNumber: true } }, leaseTerminationQuotes: { where: { cpaCancellation: true, status: "QUOTED" }, select: { id: true } }, repaymentSchedule: { select: { totalDue: true, totalPaid: true } } } } },
  })
  if (!row) return false
  if (row.loan.leaseTerminationQuotes.length > 0) return false
  if (row.loan.repaymentSchedule.some((r) => r.totalPaid < r.totalDue)) return false
  if (row.outcome === "PURCHASE" && row.loan.asset?.registrationNumber?.trim() && !row.natisTransferConfirmedAt) return false
  const now = new Date()
  await tx.leaseEndOfTerm.update({ where: { id: row.id, tenantId }, data: { status: "COMPLETED", completedAt: now } })
  if (row.outcome === "PURCHASE" && row.loan.assetId) {
    await tx.financedAsset.update({ where: { id: row.loan.assetId, tenantId }, data: { lessorStatus: "SOLD_TO_LESSEE", lessorStatusAt: now } })
  }
  if (row.loan.status !== "COMPLETED") {
    await tx.loan.update({ where: { id: loanId, tenantId }, data: { status: "COMPLETED", closedAt: now } })
  }
  await logAuditStrict({
    tenantId, userId: input.userId ?? undefined, action: AuditAction.LEASE_CLOSED, entity: "Loan", entityId: loanId,
    oldValue: { status: row.loan.status }, newValue: { status: "COMPLETED", endOfTermId: row.id, outcome: row.outcome, closedOn: sastCalendarDate(now) },
  }, tx)
  return true
}

/** Staff confirm the eNaTIS change of ownership of a purchased vehicle (the purchase checklist item). */
export async function confirmPurchaseNatis(tx: SigningTx, actor: { tenantId: string; userId: string }, loanId: string): Promise<EndResult> {
  const row = await tx.leaseEndOfTerm.findFirst({ where: { tenantId: actor.tenantId, loanId, outcome: "PURCHASE" }, select: { id: true, status: true, natisTransferConfirmedAt: true } })
  if (!row) return { kind: "not_found" }
  if (row.natisTransferConfirmedAt) return refused("confirmed", `Confirmed on ${isoOfDbDate(row.natisTransferConfirmedAt)}`)
  await tx.leaseEndOfTerm.update({ where: { id: row.id, tenantId: actor.tenantId }, data: { natisTransferConfirmedAt: new Date(), natisTransferConfirmedById: actor.userId } })
  await logAuditStrict({ tenantId: actor.tenantId, userId: actor.userId, action: AuditAction.LEASE_NATIS_CONFIRMED, entity: "LeaseEndOfTerm", entityId: row.id, newValue: { loanId, natisTransferConfirmed: true } }, tx)
  await completeEndOfTermIfSettled(tx, { tenantId: actor.tenantId, loanId, userId: actor.userId })
  return { kind: "ok", endOfTermId: row.id, status: row.status }
}
