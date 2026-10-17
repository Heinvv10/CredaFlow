import { AuditAction, logAuditStrict } from "@/lib/audit"
import { loadRateOn } from "@/lib/vat/vat-rate"
import { issueTaxInvoice } from "@/lib/vat/tax-invoice"
import { recipientAddress } from "./booking-load"
import { dbDate, isoOfDbDate } from "./dates"
import { appendLeaseCharge, cancelFutureRentals } from "./lease-charges"
import { replayLeaseCancellationCredit } from "./lease-credit-replay"
import { presentValueOfRentals } from "./lease-termination"
import { Prisma } from "@prisma/client"
import { formatMoney } from "./format"
import { assessLessorCancellation } from "./lessor-cancellation-assessment"
import type { SigningTx } from "./signing-prepare"

/**
 * Convert unearned rentals into discounted damages before sale proceeds hit
 * the debtor account. The existing recovery receipt credits the returned
 * goods' net value ONCE; a second goods credit here would double count it.
 * Recovery costs remain the actual, evidenced and approved recovery lines.
 */
export async function prepareLeaseRecoveryDamages(tx: SigningTx, input: {
  tenantId: string; userId: string; loanId: string; recoveredOn: string; today: string; netProceedsCents: number; chargedCostsCents: number; recoveryId?: string; assessment?: unknown
}): Promise<{ chargedCostsCents: number }> {
  const { tenantId, loanId } = input
  const loan = await tx.loan.findFirst({ where: { id: loanId, tenantId }, include: {
    entity: true, client: true, leaseTerminationQuotes: { where: { status: "ACCEPTED" } }, leaseEndOfTerm: true,
    leaseRentals: { where: { cancelledAt: null, dueDate: { gt: dbDate(input.recoveredOn) } } },
    contractRates: { where: { effectiveDate: { lte: dbDate(input.recoveredOn) } }, orderBy: { effectiveDate: "desc" }, take: 1 },
  } })
  if (!loan || !["OPERATING_LEASE", "FULL_MAINTENANCE_LEASE"].includes(loan.contractType)) return { chargedCostsCents: input.chargedCostsCents }
  if (loan.leaseTerminationQuotes.length) {
    if (loan.leaseTerminationQuotes.some((q) => q.lessorCancellation)) {
      const prior = loan.leaseTerminationQuotes.find((q) => q.lessorCancellation)!
      const assessment = prior.reasonableAssessment as { chargedCostsCents?: number } | null
      return { chargedCostsCents: assessment?.chargedCostsCents ?? input.chargedCostsCents }
    }
    throw new RangeError("The lease already ended under its termination quote; do not credit returned goods twice through a second cancellation")
  }
  if (loan.leaseEndOfTerm && loan.leaseEndOfTerm.status !== "EXTENDING") throw new RangeError("A return or purchase is already under way: complete that existing end-of-term outcome rather than cancelling twice")
  const lessee = loan.entity ?? loan.client
  const address = lessee ? recipientAddress(lessee) : null
  if (!lessee || !address) throw new RangeError("The lessee's address is required on the damages invoice")
  const pvCents = presentValueOfRentals(loan.leaseRentals.map((r) => ({ dueDate: isoOfDbDate(r.dueDate), rentalExclVatCents: r.rentalExclVatCents })), input.recoveredOn,
    Number(loan.contractRates[0]?.resultingRate ?? loan.interestRatePm * 12))
  const undiscounted = loan.leaseRentals.reduce((sum, r) => sum + r.rentalExclVatCents, 0)
  const vat = await loadRateOn(tx, input.today)
  let reasonableAssessment: ReturnType<typeof assessLessorCancellation> | null = null
  if (loan.cpaApplies) {
    const recovery = input.recoveryId ? await tx.recovery.findFirst({ where: { id: input.recoveryId, tenantId, loanId, status: "SOLD" }, include: { costs: { where: { status: "APPROVED" } }, sales: { where: { status: "COMPLETED" } } } }) : null
    if (!recovery || isoOfDbDate(recovery.recoveredOn) !== input.recoveredOn) throw new RangeError("An actual sold recovery of this lease is required for its cancellation assessment")
    const actualCharged = recovery.costs.filter((c) => c.treatment === "CHARGE_TO_ACCOUNT")
    const actualDeducted = recovery.costs.filter((c) => c.treatment === "DEDUCT_FROM_PROCEEDS").reduce((sum, c) => sum + c.grossCents, 0)
    if (actualCharged.reduce((sum, c) => sum + c.grossCents, 0) !== input.chargedCostsCents || !recovery.sales[0]
      || Math.max(0, recovery.sales[0].priceInclVatCents - actualDeducted) !== input.netProceedsCents) throw new RangeError("Assess actual approved costs and this recovery's completed sale proceeds")
    reasonableAssessment = assessLessorCancellation({ pvExclVatCents: pvCents, undiscountedRentalsCents: undiscounted,
      netProceedsCents: input.netProceedsCents, chargedCosts: actualCharged.map((c) => ({ id: c.id, grossCents: c.grossCents })), vatRateTenThousandths: vat.rateTenThousandths }, input.assessment)
  }
  const damagesExclVatCents = reasonableAssessment ? reasonableAssessment.damagesExclVatCents : pvCents
  const quote = await tx.leaseTerminationQuote.create({ data: {
    tenantId, loanId, recoveryId: input.recoveryId, reasonableAssessment: reasonableAssessment ? reasonableAssessment as unknown as Prisma.InputJsonValue : undefined, quotedOn: dbDate(input.today), terminationDate: dbDate(input.recoveredOn), validUntil: dbDate(input.today), cpaCancellation: false, lessorCancellation: true,
    remainingRentals: loan.leaseRentals.length, pvCents: damagesExclVatCents, penaltyCents: 0, arrearsCents: 0, invoiceExclVatCents: damagesExclVatCents, invoiceVatCents: 0, totalCents: damagesExclVatCents,
    basis: loan.cpaApplies ? `CPA lessor breach cancellation, clause 9.10/CPA s48: arrears remain separate. Approved net charge including VAT ${formatMoney(reasonableAssessment!.assessedChargeCents)}; financial ceiling ${formatMoney(reasonableAssessment!.ceilingCents)}. Gross taxable damages ${formatMoney(reasonableAssessment!.damagesInclVatCents)}; actual net goods proceeds ${formatMoney(input.netProceedsCents)} credited once; actual approved costs ${formatMoney(input.chargedCostsCents)}; noncash cost concession ${formatMoney(reasonableAssessment!.costConcessionCents)}. Reason: ${reasonableAssessment!.rationale}. Fairness: ${reasonableAssessment!.fairnessReason}. All ten case-specific factor findings are retained with this assessment.`
      : "Commercial lessor cancellation: arrears plus present value of remaining rentals at the contract rate on cancellation, no percentage penalty. Net sale proceeds are credited once.",
    createdById: input.userId,
  } })
  const invoice = damagesExclVatCents ? await issueTaxInvoice(tx, { tenantId, loanId, issueDate: input.today, supplyDate: input.today, createdById: input.userId,
    recipient: { name: loan.entity?.legalName ?? `${loan.client?.firstName} ${loan.client?.lastName}`, address, vatNumber: loan.entity?.vatNumber ?? null },
    lines: [{ description: `Lessor cancellation damages, lease ${loan.reference}: assessed amount after noncash concession; actual net sale proceeds credited separately once; no percentage penalty`, ...(reasonableAssessment ? { inclVatCents: reasonableAssessment.damagesInclVatCents } : { unitExclVatCents: damagesExclVatCents, quantity: 1 }) }],
  }) : null
  await cancelFutureRentals(tx, { tenantId, loanId, terminationDate: input.recoveredOn, actorUserId: input.userId })
  const scheduleId = invoice ? await appendLeaseCharge(tx, { tenantId, loanId, amountCents: invoice.totalInclVatCents, dueDate: input.today, actorUserId: input.userId, why: "lease_recovery_damages" }) : null
  await tx.leaseTerminationQuote.update({ where: { id: quote.id }, data: { status: "ACCEPTED", acceptedAt: new Date(), acceptedById: input.userId, taxInvoiceId: invoice?.id, scheduleId,
    invoiceVatCents: invoice?.vatCents ?? 0, totalCents: invoice?.totalInclVatCents ?? 0 } })
  if (loan.leaseEndOfTerm) {
    await tx.leaseEndOfTerm.update({ where: { id: loan.leaseEndOfTerm.id, tenantId }, data: { extensionEndsOn: dbDate(input.recoveredOn) } })
  } else await tx.leaseEndOfTerm.create({ data: { tenantId, loanId, origin: "EARLY_TERMINATION", outcome: "RETURN", status: "ELECTED", electedById: input.userId } })
  await replayLeaseCancellationCredit(tx, { tenantId, loanId, userId: input.userId, reference: quote.id })
  await logAuditStrict({ tenantId, userId: input.userId, action: AuditAction.LEASE_EARLY_TERMINATION_ACCEPTED, entity: "LeaseTerminationQuote", entityId: quote.id,
    newValue: { loanId, lessorCancellation: true, cancellationOn: input.recoveredOn, pvCents, penaltyCents: 0, goodsCredit: "net_sale_receipt", reasonableAssessment } }, tx)
  return { chargedCostsCents: reasonableAssessment?.chargedCostsCents ?? input.chargedCostsCents }
}
