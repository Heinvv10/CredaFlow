/**
 * Changes to a booked lease's ledger after booking (slice 3, C7–C8), in the
 * caller's transaction, keeping the ledger mapping of ./lease-ledger.ts:
 * every schedule row's principalDue = totalDue, and the loan's principal,
 * totalRepayable and outstandingPrincipal move with the rows.
 *
 * appendLeaseCharge   an end-of-term, purchase or termination tax invoice
 *                     becomes a schedule row (no LeaseRental: it is not a
 *                     rental), due on `dueDate`, so receipts, arrears and
 *                     reminders collect it. A lease whose rentals were all
 *                     paid (COMPLETED) is reopened ACTIVE for it, audited.
 * appendExtensionRental  a month-to-month extension's next rental: a schedule
 *                     row and its LeaseRental at the last rental and maintenance.
 * cancelFutureRentals early termination: the uninvoiced rentals due after the
 *                     termination date are cancelled; their schedule rows go
 *                     to 0 (guardLeaseRental admits it inside the
 *                     credaflow.lease_terminate flag only).
 * The loan is locked first (lib/loan/lock.ts), so receipts serialise with these.
 */
import { consumeDeferredLeaseRateTax } from "./lease-rate-tax-adjustment"
import type { RepriceTx } from "./reprice-loan"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { lockLoanForUpdate } from "@/lib/loan/lock"
import { nextPaymentDueDate, recomputeLoanBalances } from "@/lib/loan/balances"
import { issueCreditNote } from "@/lib/vat/credit-note"
import { sastCalendarDate } from "@/lib/date/sast"
import { replayLeaseCancellationCredit } from "./lease-credit-replay"
import { vatOnExclusive } from "@/lib/vat/amounts"
import type { VatRateInForce } from "@/lib/vat/vat-rate"
import { addMonthsClamped, dbDate, isoOfDbDate } from "./dates"
import { dueDateInstant } from "./schedule-records"
import type { SigningTx } from "./signing-prepare"

export async function refreshLoan(tx: SigningTx, tenantId: string, loanId: string, delta: number, actorUserId: string | null, why: string): Promise<void> {
  const loan = await tx.loan.findFirstOrThrow({
    where: { id: loanId, tenantId },
    select: { status: true, principal: true, repaymentSchedule: { orderBy: { installmentNo: "asc" } } },
  })
  const principal = loan.principal + delta
  const balances = recomputeLoanBalances(principal, loan.repaymentSchedule, new Date())
  const owed = loan.repaymentSchedule.some((r) => r.totalPaid < r.totalDue)
  const reopen = loan.status === "COMPLETED" && owed
  await tx.loan.update({
    where: { id: loanId, tenantId },
    data: {
      principal, totalRepayable: { increment: delta }, outstandingPrincipal: balances.outstandingPrincipal,
      maturityDate: loan.repaymentSchedule[loan.repaymentSchedule.length - 1].dueDate,
      nextPaymentDate: nextPaymentDueDate(loan.repaymentSchedule), arrearsAmount: balances.arrearsAmount, daysInArrears: balances.daysInArrears,
      ...(reopen ? { status: "ACTIVE" as const, closedAt: null } : {}),
    },
  })
  if (reopen) {
    await logAuditStrict({
      tenantId, userId: actorUserId ?? undefined, action: AuditAction.LOAN_STATUS_CHANGED, entity: "Loan", entityId: loanId,
      oldValue: { status: "COMPLETED" }, newValue: { status: "ACTIVE", reason: why },
    }, tx)
  }
}

export async function appendLeaseCharge(
  tx: SigningTx,
  input: { tenantId: string; loanId: string; amountCents: number; dueDate: string; actorUserId: string | null; why: string },
): Promise<string> {
  if (!Number.isSafeInteger(input.amountCents) || input.amountCents <= 0) throw new RangeError("a lease charge must be a positive number of cents")
  await lockLoanForUpdate(tx, input.loanId)
  const last = await tx.repaymentSchedule.findFirstOrThrow({ where: { tenantId: input.tenantId, loanId: input.loanId }, orderBy: { installmentNo: "desc" }, select: { installmentNo: true } })
  // Never before the last row still owed; cancelled rentals (0 due) do not push the charge out to the old term's end.
  const lastOwed = await tx.repaymentSchedule.findFirst({ where: { tenantId: input.tenantId, loanId: input.loanId, totalDue: { gt: 0 } }, orderBy: { dueDate: "desc" }, select: { dueDate: true } })
  const due = dueDateInstant(input.dueDate)
  const row = await tx.repaymentSchedule.create({
    data: {
      tenantId: input.tenantId, loanId: input.loanId, installmentNo: last.installmentNo + 1,
      dueDate: lastOwed && due.getTime() < lastOwed.dueDate.getTime() ? lastOwed.dueDate : due,
      principalDue: input.amountCents, interestDue: 0, feesDue: 0, creditLifePremiumDue: 0, totalDue: input.amountCents, status: "PENDING",
    },
    select: { id: true },
  })
  await refreshLoan(tx, input.tenantId, input.loanId, input.amountCents, input.actorUserId, input.why)
  return row.id
}

/** The next month-to-month rental: one month after the last, at the last rental and maintenance, VAT at `vat`. */
export async function appendExtensionRental(
  tx: SigningTx,
  input: { tenantId: string; loanId: string; vat: VatRateInForce; actorUserId: string | null },
): Promise<{ periodNo: number; dueDate: string }> {
  await lockLoanForUpdate(tx, input.loanId)
  const lastRental = await tx.leaseRental.findFirstOrThrow({
    where: { tenantId: input.tenantId, loanId: input.loanId }, orderBy: { periodNo: "desc" },
    select: { dueDate: true, rentalExclVatCents: true, maintenanceExclVatCents: true },
  })
  const lastRow = await tx.repaymentSchedule.findFirstOrThrow({ where: { tenantId: input.tenantId, loanId: input.loanId }, orderBy: { installmentNo: "desc" }, select: { installmentNo: true } })
  const dueDate = addMonthsClamped(isoOfDbDate(lastRental.dueDate), 1)
  const rate = input.vat.rateTenThousandths
  const vatCents = vatOnExclusive(lastRental.rentalExclVatCents, rate) + vatOnExclusive(lastRental.maintenanceExclVatCents, rate)
  const totalCents = lastRental.rentalExclVatCents + lastRental.maintenanceExclVatCents + vatCents
  const periodNo = lastRow.installmentNo + 1
  const schedule = await tx.repaymentSchedule.create({
    data: {
      tenantId: input.tenantId, loanId: input.loanId, installmentNo: periodNo, dueDate: dueDateInstant(dueDate),
      principalDue: totalCents, interestDue: 0, feesDue: 0, creditLifePremiumDue: 0, totalDue: totalCents, status: "PENDING",
    },
    select: { id: true },
  })
  await tx.leaseRental.create({
    data: {
      tenantId: input.tenantId, loanId: input.loanId, scheduleId: schedule.id, periodNo, dueDate: dbDate(dueDate),
      rentalExclVatCents: lastRental.rentalExclVatCents, maintenanceExclVatCents: lastRental.maintenanceExclVatCents,
      vatCents, totalCents, vatRate: input.vat.rate,
    },
  })
  await refreshLoan(tx, input.tenantId, input.loanId, totalCents, input.actorUserId, "lease_extension_rental")
  return { periodNo, dueDate }
}

/** Cancels the uninvoiced rentals due after `terminationDate`; returns how many, and their total. */
export async function cancelFutureRentals(
  tx: SigningTx,
  input: { tenantId: string; loanId: string; terminationDate: string; actorUserId: string | null },
): Promise<{ cancelled: number; totalCents: number }> {
  await lockLoanForUpdate(tx, input.loanId)
  const rentals = await tx.leaseRental.findMany({
    where: { tenantId: input.tenantId, loanId: input.loanId, cancelledAt: null, dueDate: { gt: dbDate(input.terminationDate) } },
    select: { id: true, scheduleId: true, totalCents: true, taxInvoiceId: true, taxInvoice: { select: { totalExclVatCents: true } }, schedule: { select: { totalPaid: true } } },
  })
  const credits = new Map<string, string>()
  // Credit every superseded supply before changing rows: the credit-note
  // issuer forces deferred checks, so the existing ledger must still balance.
  for (const rental of rentals) {
    if (!rental.taxInvoiceId || !rental.taxInvoice) continue
    const prior = await tx.creditNote.aggregate({ where: { tenantId: input.tenantId, invoiceId: rental.taxInvoiceId }, _sum: { exclVatCents: true } })
    const remaining = rental.taxInvoice.totalExclVatCents - (prior._sum.exclVatCents ?? 0)
    const credit = remaining > 0 ? await issueCreditNote(tx, { tenantId: input.tenantId, invoiceId: rental.taxInvoiceId, issueDate: sastCalendarDate(new Date()),
      reason: `Lease cancellation effective ${input.terminationDate}`, exclVatCents: remaining, createdById: input.actorUserId })
      : await tx.creditNote.findFirstOrThrow({ where: { tenantId: input.tenantId, invoiceId: rental.taxInvoiceId }, orderBy: { createdAt: "desc" } })
    credits.set(rental.id, credit.id)
    await logAuditStrict({ tenantId: input.tenantId, userId: input.actorUserId ?? undefined, action: AuditAction.LEASE_EARLY_TERMINATION_ACCEPTED, entity: "CreditNote", entityId: credit.id,
      newValue: { loanId: input.loanId, rentalId: rental.id, invoiceId: rental.taxInvoiceId, terminationDate: input.terminationDate, amountCents: credit.inclVatCents } }, tx)
  }
  await tx.$executeRawUnsafe("SELECT set_config('credaflow.lease_terminate', 'on', true)")
  const now = new Date()
  for (const rental of rentals) {
    await tx.leaseRental.update({ where: { id: rental.id, tenantId: input.tenantId }, data: { cancelledAt: now, cancellationCreditNoteId: credits.get(rental.id) ?? null } })
    await tx.repaymentSchedule.update({ where: { id: rental.scheduleId, tenantId: input.tenantId }, data: { principalDue: 0, totalDue: 0 } })
    const contribution = credits.has(rental.id) ? await tx.maintenanceFundMovement.findFirst({ where: { tenantId: input.tenantId, leaseRentalId: rental.id, kind: "CONTRIBUTION" } }) : null
    if (contribution) await tx.maintenanceFundMovement.create({ data: {
      tenantId: input.tenantId, fundId: contribution.fundId, kind: "CONTRIBUTION_CREDIT", amountCents: contribution.amountCents,
      creditedLeaseRentalId: rental.id, occurredOn: dbDate(sastCalendarDate(new Date())), createdById: input.actorUserId,
      note: `Future maintenance supply credited on cancellation ${input.terminationDate}`,
    } })
  }
  await tx.$executeRawUnsafe("SELECT set_config('credaflow.lease_terminate', 'off', true)")
  const totalCents = rentals.reduce((sum, r) => sum + r.totalCents, 0)
  if (rentals.length > 0) {
    await consumeDeferredLeaseRateTax(tx as unknown as RepriceTx, { tenantId: input.tenantId, loanId: input.loanId, rentalIds: rentals.map(rental => rental.id), today: input.terminationDate, actorUserId: input.actorUserId })
    await refreshLoan(tx, input.tenantId, input.loanId, -totalCents, input.actorUserId, "lease_early_termination")
    await replayLeaseCancellationCredit(tx, { tenantId: input.tenantId, loanId: input.loanId, userId: input.actorUserId, reference: input.terminationDate })
  }
  return { cancelled: rentals.length, totalCents }
}

