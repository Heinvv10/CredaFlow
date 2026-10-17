import { amendedLeaseRentals } from "./lease-rate-tax-adjustment"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { loadRateOn } from "@/lib/vat/vat-rate"
import { splitInclusive } from "@/lib/vat/amounts"
import { issueTaxInvoice } from "@/lib/vat/tax-invoice"
import { recipientAddress } from "./booking-load"
import { dbDate, isoOfDbDate } from "./dates"
import { appendLeaseCharge, cancelFutureRentals } from "./lease-charges"
import { replayLeaseCancellationCredit } from "./lease-credit-replay"
import { presentValueOfRentals } from "./lease-termination"
import type { SigningTx } from "./signing-prepare"

/**
 * Convert unearned rentals into discounted damages before sale proceeds hit
 * the debtor account. The existing recovery receipt credits the returned
 * goods' net value ONCE; a second goods credit here would double count it.
 * Recovery costs remain the actual, evidenced and approved recovery lines.
 */
export async function prepareLeaseRecoveryDamages(tx: SigningTx, input: {
  tenantId: string; userId: string; loanId: string; recoveredOn: string; today: string; netProceedsCents: number; chargedCostsCents: number
}): Promise<void> {
  const { tenantId, loanId } = input
  const loan = await tx.loan.findFirst({ where: { id: loanId, tenantId }, include: {
    entity: true, client: true, leaseTerminationQuotes: { where: { status: "ACCEPTED" } }, leaseEndOfTerm: true,
    leaseRentals: { where: { cancelledAt: null, dueDate: { gt: dbDate(input.recoveredOn) } } },
    contractRates: { where: { effectiveDate: { lte: dbDate(input.recoveredOn) } }, orderBy: { effectiveDate: "desc" }, take: 1 },
  } })
  if (!loan || !["OPERATING_LEASE", "FULL_MAINTENANCE_LEASE"].includes(loan.contractType)) return
  if (loan.leaseTerminationQuotes.length) {
    if (loan.leaseTerminationQuotes.some((q) => q.lessorCancellation)) return
    throw new RangeError("The lease already ended under its termination quote; do not credit returned goods twice through a second cancellation")
  }
  if (loan.leaseEndOfTerm && loan.leaseEndOfTerm.status !== "EXTENDING") throw new RangeError("A return or purchase is already under way: complete that existing end-of-term outcome rather than cancelling twice")
  const lessee = loan.entity ?? loan.client
  const address = lessee ? recipientAddress(lessee) : null
  if (!lessee || !address) throw new RangeError("The lessee's address is required on the damages invoice")
  const amendedRentals = await amendedLeaseRentals(tx, tenantId, loan.id, loan.leaseRentals)
  const pvCents = presentValueOfRentals(amendedRentals.map((r) => ({ dueDate: isoOfDbDate(r.dueDate), rentalExclVatCents: r.rentalExclVatCents })), input.recoveredOn,
    Number(loan.contractRates[0]?.resultingRate ?? loan.interestRatePm * 12))
  const undiscounted = amendedRentals.reduce((sum, r) => sum + r.rentalExclVatCents, 0)
  const vat = await loadRateOn(tx, input.today)
  const cappedGross = Math.max(0, input.netProceedsCents + Math.max(0, undiscounted - 1) - input.chargedCostsCents)
  const damagesExclVatCents = loan.cpaApplies ? Math.min(pvCents, splitInclusive(cappedGross, vat.rateTenThousandths).exclVatCents) : pvCents
  const quote = await tx.leaseTerminationQuote.create({ data: {
    tenantId, loanId, quotedOn: dbDate(input.today), terminationDate: dbDate(input.recoveredOn), validUntil: dbDate(input.today), cpaCancellation: false, lessorCancellation: true,
    remainingRentals: loan.leaseRentals.length, pvCents: damagesExclVatCents, penaltyCents: 0, arrearsCents: 0, invoiceExclVatCents: damagesExclVatCents, invoiceVatCents: 0, totalCents: damagesExclVatCents,
    basis: loan.cpaApplies ? "CPA lessor cancellation: arrears plus discounted remaining rentals, no percentage penalty. Net sale proceeds credit the goods value once; only actual documented recovery costs are allowed and the final cancellation charge is capped below undiscounted remaining rentals."
      : "Commercial lessor cancellation: arrears plus present value of remaining rentals at the contract rate on cancellation, no percentage penalty. Net sale proceeds are credited once.",
    createdById: input.userId,
  } })
  const invoice = damagesExclVatCents ? await issueTaxInvoice(tx, { tenantId, loanId, issueDate: input.today, supplyDate: input.today, createdById: input.userId,
    recipient: { name: loan.entity?.legalName ?? `${loan.client?.firstName} ${loan.client?.lastName}`, address, vatNumber: loan.entity?.vatNumber ?? null },
    lines: [{ description: `Lessor cancellation damages, lease ${loan.reference}: PV at the contract rate; no percentage penalty`, unitExclVatCents: damagesExclVatCents, quantity: 1 }],
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
    newValue: { loanId, lessorCancellation: true, cancellationOn: input.recoveredOn, pvCents, penaltyCents: 0, goodsCredit: "net_sale_receipt" } }, tx)
}
