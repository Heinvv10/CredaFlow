import { Prisma } from "@prisma/client"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { allocateReceipts, recomputeLoanBalances } from "@/lib/loan/balances"
import { sastCalendarDate } from "@/lib/date/sast"
import { loanSettlementFigures } from "@/lib/loan/charges-summary"
import { applyManualReceipt, type PaymentDb } from "@/lib/loan/apply-payment"
import { issueTaxInvoice } from "@/lib/vat/tax-invoice"
import { recipientAddress } from "./booking-load"
import { dbDate, isoOfDbDate, toDayNumber } from "./dates"
import { appendLeaseCharge, cancelFutureRentals } from "./lease-charges"
import { replayLeaseCancellationCredit } from "./lease-credit-replay"
import { presentValueOfRentals } from "./lease-termination"
import type { SigningTx } from "./signing-prepare"

/** Staff records a write-off and insurance actually received, in one audited transaction. */
export async function recordLeaseTotalLoss(tx: SigningTx, actor: { tenantId: string; userId: string }, input: {
  loanId: string; today: string; lossOn?: string; insuranceReceivedOn?: string; insuranceProceedsCents: number; evidence: string
}) {
  if (!Number.isSafeInteger(input.insuranceProceedsCents) || input.insuranceProceedsCents < 0 || typeof input.evidence !== "string" || !input.evidence.trim()) {
    return { kind: "refused", reason: "invalid_loss", error: "Record the write-off evidence and non-negative insurance proceeds actually received" }
  }
  const lossOn = input.lossOn ?? input.today
  const insuranceReceivedOn = input.insuranceReceivedOn ?? input.today
  try { toDayNumber(lossOn); toDayNumber(insuranceReceivedOn) } catch {
    return { kind: "refused", reason: "invalid_loss_date", error: "Record valid calendar dates for the loss and actual insurer receipt" }
  }
  if (lossOn > input.today || insuranceReceivedOn > input.today) return { kind: "refused", reason: "invalid_loss_date", error: "Loss and receipt dates cannot be in the future" }
  const { tenantId } = actor
  await tx.$queryRaw`SELECT "id" FROM "Loan" WHERE "id" = ${input.loanId} AND "tenantId" = ${tenantId} FOR UPDATE`
  const loan = await tx.loan.findFirst({ where: { id: input.loanId, tenantId, contractType: { in: ["OPERATING_LEASE", "FULL_MAINTENANCE_LEASE"] } }, include: {
    leaseEndOfTerm: true, leaseTerminationQuotes: true, entity: true, client: true, repaymentSchedule: true,
    leaseRentals: { where: { cancelledAt: null } }, contractRates: { where: { effectiveDate: { lte: dbDate(lossOn) } }, orderBy: { effectiveDate: "desc" }, take: 1 },
  } })
  if (!loan) return { kind: "not_found" }
  if (lossOn < sastCalendarDate(loan.startDate) || insuranceReceivedOn < sastCalendarDate(loan.startDate)) return { kind: "refused", reason: "invalid_loss_date", error: "Loss and receipt dates cannot precede commencement" }
  if (loan.leaseEndOfTerm || loan.leaseTerminationQuotes.some((q) => q.totalLoss)) return { kind: "refused", reason: "end_of_term", error: "The lease is already ending" }
  if (!["ACTIVE", "DEFAULTED", "COMPLETED"].includes(loan.status)) return { kind: "refused", reason: "lease_closed", error: "The lease is closed" }
  const lessee = loan.entity ?? loan.client
  const address = lessee ? recipientAddress(lessee) : null
  if (!lessee || !address) return { kind: "refused", reason: "recipient", error: "The lessee's address is required" }
  const pvCents = presentValueOfRentals(loan.leaseRentals.map((r) => ({ dueDate: isoOfDbDate(r.dueDate), rentalExclVatCents: r.rentalExclVatCents })), lossOn, Number(loan.contractRates[0]?.resultingRate ?? new Prisma.Decimal(loan.interestRatePm * 12)))
  const lossAsOf = new Date(`${lossOn}T23:59:59.999+02:00`)
  const receiptsAtLoss = await tx.payment.findMany({ where: { tenantId, loanId: loan.id, reversed: false, allocationStatus: "ALLOCATED", receivedAt: { lte: lossAsOf } } })
  const paidAtLoss = receiptsAtLoss.reduce((sum, p) => sum + p.amount - p.defaultInterestAllocated - p.chargeFeesAllocated, 0)
  const orderedRows = [...loan.repaymentSchedule].sort((a, b) => a.installmentNo - b.installmentNo)
  const allocated = allocateReceipts(orderedRows, paidAtLoss)
  const historicalRows = orderedRows.map((r, i) => ({ ...r, totalPaid: allocated[i] }))
  const balancesAtLoss = recomputeLoanBalances(loan.principal, historicalRows, lossAsOf)
  const arrearsCents = (await loanSettlementFigures(tx, { ...loan, ...balancesAtLoss, repaymentSchedule: historicalRows }, lossAsOf)).arrearsIncludingCharges
  const quote = await tx.leaseTerminationQuote.create({ data: {
    tenantId, loanId: loan.id, quotedOn: dbDate(input.today), terminationDate: dbDate(lossOn), validUntil: dbDate(input.today), cpaCancellation: false, totalLoss: true,
    insuranceProceedsCents: input.insuranceProceedsCents, lossEvidence: input.evidence.trim(), remainingRentals: loan.leaseRentals.filter((r) => isoOfDbDate(r.dueDate) > lossOn).length,
    pvCents, penaltyCents: 0, arrearsCents, invoiceExclVatCents: 0, invoiceVatCents: 0, totalCents: arrearsCents,
    basis: `Total loss ends the lease on ${lossOn}: arrears plus present value at the contract rate, without a penalty, less insurance proceeds actually received. Insurance is credited through the receipt ledger.`, createdById: actor.userId,
  } })
  await cancelFutureRentals(tx, { tenantId, loanId: loan.id, terminationDate: lossOn, actorUserId: actor.userId })
  const invoice = pvCents > 0 ? await issueTaxInvoice(tx, { tenantId, loanId: loan.id, issueDate: input.today, supplyDate: lossOn, createdById: actor.userId,
    recipient: { name: loan.entity?.legalName ?? `${loan.client?.firstName} ${loan.client?.lastName}`, address, vatNumber: loan.entity?.vatNumber ?? null },
    lines: [{ description: `Total loss of lease ${loan.reference}: present value of remaining rentals, no penalty. Evidence ${input.evidence}`, inclVatCents: pvCents }],
  }) : null
  const scheduleId = invoice ? await appendLeaseCharge(tx, { tenantId, loanId: loan.id, amountCents: invoice.totalInclVatCents, dueDate: lossOn, actorUserId: actor.userId, why: "lease_total_loss" }) : null
  await tx.leaseTerminationQuote.update({ where: { id: quote.id }, data: { status: "ACCEPTED", acceptedAt: new Date(), acceptedById: actor.userId,
    taxInvoiceId: invoice?.id, scheduleId, invoiceExclVatCents: invoice?.totalExclVatCents ?? 0, invoiceVatCents: invoice?.vatCents ?? 0, totalCents: pvCents + arrearsCents } })
  await tx.leaseEndOfTerm.create({ data: { tenantId, loanId: loan.id, origin: "EARLY_TERMINATION", outcome: "TOTAL_LOSS", status: "ELECTED", electedById: actor.userId } })
  if (loan.assetId) await tx.financedAsset.update({ where: { id: loan.assetId, tenantId }, data: { lessorStatus: "TOTAL_LOSS", lessorStatusAt: new Date() } })
  if (input.insuranceProceedsCents > 0) {
    const db = { $transaction: <T>(run: (client: SigningTx) => Promise<T>) => run(tx) } as unknown as PaymentDb
    await applyManualReceipt(db, { tenantId, loanId: loan.id, amount: input.insuranceProceedsCents, paymentMethod: "EFT", reference: `LOSS-${quote.id}`,
      notes: `Insurer payment: ${input.evidence}`, capturedById: actor.userId, idempotencyKey: `lease-total-loss:${quote.id}`, receivedAt: insuranceReceivedOn === input.today ? new Date() : new Date(`${insuranceReceivedOn}T12:00:00+02:00`) })
  }
  // Record insurer cash against the new damages before reallocating prepaid credit.
  await replayLeaseCancellationCredit(tx, { tenantId, loanId: loan.id, userId: actor.userId, reference: quote.id })
  await logAuditStrict({ tenantId, userId: actor.userId, action: AuditAction.LEASE_EARLY_TERMINATION_ACCEPTED, entity: "LeaseTerminationQuote", entityId: quote.id,
    newValue: { loanId: loan.id, totalLoss: true, endsOn: lossOn, recordedOn: input.today, insuranceReceivedOn, pvCents, insuranceProceedsCents: input.insuranceProceedsCents, evidence: input.evidence } }, tx)
  return { kind: "recorded", quoteId: quote.id, terminationDate: lossOn }
}
