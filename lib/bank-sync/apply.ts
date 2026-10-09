import { prisma } from "@/lib/prisma"
import { recomputeLoanBalances, nextPaymentDueDate } from "@/lib/loan/balances"
import { lockLoanForUpdate } from "@/lib/loan/lock"
import { CHARGES_FLAG_INCLUDE, chargesEnabled } from "@/lib/loan/charges-replay"
import { projectChargeAwareReceipt } from "@/lib/loan/charge-aware-receipt"
import { syncLoanCharges } from "@/lib/loan/charges-sync"
import { logAudit, AuditAction } from "@/lib/audit"
import { runWithTenant } from "@/lib/tenant-scope"
import {
  backdatingInterestRebate,
  receiptContractualTotalsUpdate,
  settlementAuditEvidence,
} from "@/lib/loan/settlement"
import { OVERPAYMENT_REASON } from "@/lib/loan/receipt-rules"
import { ChargesError } from "@/lib/loan/charges-error"
import { recordHeldReceipt } from "@/lib/payments/held-receipt"
import { closingValueDate } from "@/lib/loan/receipt-charges"
import { restampSchedulePaidAt } from "@/lib/loan/schedule-paid-at"
import {
  rejectImpossibleValueDate,
  rejectUnauthorisedBackdating,
  valueDateEvidence,
  VALUE_DATE_MESSAGES,
} from "@/lib/loan/value-date"

export class InvalidLoanStateError extends Error {}
export class TransactionNotFoundError extends Error {}

export async function applyBankTransaction(args: {
  txnId: string
  loanId: string
  tenantId: string
  userId?: string
  userEmail: string
}): Promise<{ paymentId: string }> {
  // Loan/Payment/RepaymentSchedule are tenant-scoped models — the Prisma
  // extension throws "missing-context" on their writes unless an ALS tenant
  // context is set. This function is called outside a request (auto-apply) and
  // from a server action, neither of which runs withTenantContext, so establish
  // the context here (belt-and-suspenders with the explicit where: { tenantId }).
  return runWithTenant(args.tenantId, async () => {
  const txn = await prisma.bankTransaction.findFirst({
    where: { id: args.txnId, tenantId: args.tenantId },
  })
  if (!txn) throw new TransactionNotFoundError("Bank transaction not found")
  // Only an un-actioned deposit can become a Payment. Rejects MATCHED (already
  // has a Payment) and IGNORED (a human explicitly excluded this deposit) — the
  // atomic claim below re-checks this under a row lock to close the race.
  if (txn.matchStatus !== "PROPOSED" && txn.matchStatus !== "UNMATCHED") {
    throw new InvalidLoanStateError("Only unreconciled transactions can be applied")
  }
  if (txn.direction !== "CREDIT") throw new InvalidLoanStateError("Only credit lines can be applied")

  // `asOf` is NOW and drives arrears/DPD, which must describe today.
  // `receivedAt` is when the BANK says the money landed and drives interest
  // accrual: a statement imported days late must not bill the client for the
  // gap (NCA s125(2)(b)). Both dates are already on the row.
  const asOf = new Date()
  const receivedAt = txn.valueDate ?? txn.postedDate
  const capturedBy = args.userId ? `absa-sync:${args.userId}` : "absa-sync"
  const paymentId = await prisma.$transaction(async (tx) => {
    // Serialise every writer on this loan and read its balance
    // UNDER the lock, so a receipt landing between our read and write can't be
    // lost. A read outside the transaction would let a concurrent manual/portal
    // payment commit in that gap and get clobbered.
    await lockLoanForUpdate(tx, args.loanId)

    const loan = await tx.loan.findFirst({
      where: { id: args.loanId, tenantId: args.tenantId },
      include: {
        repaymentSchedule: { orderBy: [{ dueDate: "asc" }, { installmentNo: "asc" }] },
        tenant: CHARGES_FLAG_INCLUDE,
      },
    })
    if (!loan) throw new InvalidLoanStateError("Loan not found")
    if (!["ACTIVE", "DEFAULTED"].includes(loan.status)) {
      throw new InvalidLoanStateError("Loan is not ACTIVE or DEFAULTED")
    }

    // A bank statement is a third party attesting when the money moved, which
    // is the strongest evidence available — so no recency window applies here,
    // unlike a staff-keyed date. The impossible bounds still hold: a line dated
    // before disbursement would clamp elapsed days to zero and write off every
    // cent of earned interest. Thrown BEFORE the claim below, so the row stays
    // PROPOSED for a human rather than being consumed.
    // The statement is a CSV a staff member uploads, and parse.ts bounds its
    // dates not at all — so this is NOT third-party attestation and gets the
    // same treatment as a keyed date. Calling it "bank-attested" is what let a
    // typed line skip the control entirely.
    const rejection = rejectImpossibleValueDate({
      receivedAt,
      asOf,
      loanStartDate: loan.startDate,
    })
    if (rejection) {
      throw new InvalidLoanStateError(
        `Cannot apply this deposit: ${VALUE_DATE_MESSAGES[rejection]}`,
      )
    }

    // The deposit is already in the bank account, so it is always recorded.
    // Anything above the s125 settlement amount is split off as a refund-due
    // receipt rather than collected — mirrors applyManualReceipt, per the
    // "deliberately mirrors the payment $transaction" rule in this module.
    const chargesRef = { tenantId: args.tenantId, loanId: loan.id }
    const chargesOn = chargesEnabled(loan)
    const { projection, chargesBackdating } = await projectChargeAwareReceipt(tx, {
      loan,
      schedule: loan.repaymentSchedule,
      amount: txn.amountCents,
      receivedAt,
      asOf,
      allowOverpayment: true,
    })

    // No override is expressible here — auto-apply has no human, and the
    // confirm screen supplies no reason — so a material rebate leaves the row
    // PROPOSED for someone to look at rather than booking itself.
    // Only the portion the DATE created, not the lawful early-settlement rebate
    // any client earns by paying before maturity.
    const backdating = backdatingInterestRebate({
      loan, schedule: loan.repaymentSchedule, asOf, receivedAt,
    })
    // Default charges erased by the date count too (rejectUnauthorisedBackdating).
    const rebateRejection = rejectUnauthorisedBackdating({
      interest: backdating,
      charges: chargesBackdating,
    })
    if (rebateRejection) {
      throw new InvalidLoanStateError(
        `Cannot apply this deposit: ${VALUE_DATE_MESSAGES[rebateRejection]}`,
      )
    }

    // Atomically claim the txn: only the first concurrent caller flips it from
    // PROPOSED/UNMATCHED to MATCHED; a loser (already MATCHED or IGNORED by a
    // concurrent confirm/ignore) sees count 0 and aborts — no duplicate Payment,
    // and an IGNORED deposit can never be booked.
    const claim = await tx.bankTransaction.updateMany({
      where: { id: txn.id, tenantId: args.tenantId, matchStatus: { in: ["PROPOSED", "UNMATCHED"] } },
      data: { matchStatus: "MATCHED" },
    })
    if (claim.count !== 1) {
      throw new InvalidLoanStateError("Transaction already reconciled or ignored")
    }

    // Nothing owed → no allocated portion. Mirrors applyManualReceipt's
    // fullyUnapplied branch: one refund-due receipt for the whole deposit, and
    // the loan is left completely untouched. Without this the deposit booked as
    // a R0.00 ALLOCATED payment that printed on the client's statement and
    // overwrote lastPaymentAmount with zero.
    const fullyUnapplied = projection.appliedAmount === 0

    const payment = await tx.payment.create({
      data: {
        tenantId: args.tenantId,
        loanId: loan.id,
        amount: fullyUnapplied ? txn.amountCents : projection.appliedAmount,
        paymentMethod: "EFT",
        receivedAt,
        reference: txn.rawReference,
        notes: fullyUnapplied
          ? "Reconciled from ABSA statement — nothing outstanding, refund due"
          : "Reconciled from ABSA statement",
        capturedBy: args.userId ? `absa-sync:${args.userId}` : "absa-sync",
        ...(fullyUnapplied
          ? {
              allocationStatus: "UNAPPLIED" as const,
              reconciliationReason: OVERPAYMENT_REASON,
            }
          : {}),
      },
    })

    // The BankTransaction links to the ALLOCATED receipt above; this sibling
    // carries only the excess the client is owed back.
    if (!fullyUnapplied && projection.excessAmount > 0) {
      await tx.payment.create({
        data: {
          tenantId: args.tenantId,
          loanId: loan.id,
          amount: projection.excessAmount,
          paymentMethod: "EFT",
          receivedAt,
          reference: txn.rawReference,
          notes: "Reconciled from ABSA statement — received above settlement",
            capturedBy: args.userId ? `absa-sync:${args.userId}` : "absa-sync",
          allocationStatus: "UNAPPLIED",
          reconciliationReason: OVERPAYMENT_REASON,
          parentPaymentId: payment.id,
        },
      })
    }

    const postRows = projection.rows
    for (let i = 0; fullyUnapplied ? false : i < postRows.length; i++) {
      const before = loan.repaymentSchedule[i]
      const after = postRows[i]
      if (
        after.totalPaid === before.totalPaid
        && after.interestDue === before.interestDue
        && after.totalDue === before.totalDue
      ) continue
      const isPaid = after.totalPaid >= after.totalDue
      await tx.repaymentSchedule.update({
        where: { id: after.id },
        data: {
          totalPaid: after.totalPaid,
          interestDue: after.interestDue,
          totalDue: after.totalDue,
          status: isPaid ? "PAID" : "PARTIAL",
          paidAt: isPaid ? receivedAt : null,
        },
      })
    }
    // A deposit dated before a receipt already on the loan changes which
    // receipt completed rows the loop skipped: re-date every row from the replay.
    // Both conditions are fast paths, not correctness: on a charges-live loan the sync below
    // re-dates every row anyway, and a fully unapplied deposit adds no allocated receipt to replay.
    if (!chargesOn && !fullyUnapplied) {
      await restampSchedulePaidAt(tx, chargesRef, { source: "bank_sync", userId: args.userId ?? null, userEmail: args.userEmail })
    }

    const balances = recomputeLoanBalances(loan.principal, postRows, asOf)
    const newTotalPaid = projection.newTotalPaid
    const isCompleted = projection.isCompleted
    if (!fullyUnapplied) await tx.loan.update({
      where: { id: loan.id, tenantId: args.tenantId },
      data: {
        totalPaid: newTotalPaid,
        totalInterest: projection.totalInterest,
        totalRepayable: projection.totalRepayable,
        ...receiptContractualTotalsUpdate(projection),
        outstandingPrincipal: balances.outstandingPrincipal,
        // The LATEST receipt by value date, not simply the one just booked.
        // A back-dated deposit is older than a receipt already on the loan, so
        // writing it unconditionally moves this field BACKWARDS — and it
        // prints on the Certificate of Balance (NCA s.108), so a certificate
        // reissued after a late import would state an earlier last payment
        // than one already handed to a client or an attorney.
        lastPaymentDate:
          loan.lastPaymentDate && loan.lastPaymentDate > receivedAt
            ? loan.lastPaymentDate
            : receivedAt,
        lastPaymentAmount: projection.appliedAmount,
        nextPaymentDate: nextPaymentDueDate(postRows),
        status: isCompleted ? "COMPLETED" : loan.status,
        closedAt: isCompleted ? await closingValueDate(tx, loan.id, receivedAt) : loan.closedAt,
        daysInArrears: balances.daysInArrears,
        arrearsAmount: balances.arrearsAmount,
      },
    })

    await tx.bankTransaction.update({
      where: { id: txn.id },
      data: { paymentId: payment.id, matchedLoanId: loan.id, reviewedBy: args.userId ?? null, reviewedAt: asOf },
    })
    await tx.auditLog.create({
      data: {
        tenantId: args.tenantId,
        userId: args.userId ?? null,
        userEmail: args.userEmail,
        action: AuditAction.BANK_TXN_RECONCILED,
        entity: "BankTransaction",
        entityId: txn.id,
        oldValue: {
          matchStatus: txn.matchStatus,
          loanStatus: loan.status,
          totalPaid: loan.totalPaid,
          totalInterest: loan.totalInterest,
          totalRepayable: loan.totalRepayable,
        },
        newValue: {
          loanId: args.loanId,
          amountCents: txn.amountCents,
          paymentId: payment.id,
          matchStatus: "MATCHED",
          loanStatus: isCompleted ? "COMPLETED" : loan.status,
          totalPaid: newTotalPaid,
          ...settlementAuditEvidence(projection),
          // Mirrors the manual path: without these an auditor reading a bank
          // reconciliation cannot see that money was split off, nor find the
          // refund-due sibling.
          appliedAmount: projection.appliedAmount,
          excessAmount: projection.excessAmount,
          ...valueDateEvidence({
            receivedAt,
            asOf,
            source: "BANK_STATEMENT",
            interestRebateCents: backdating.rebateCents + chargesBackdating.rebateCents,
            defaultChargesRebateCents: chargesBackdating.rebateCents,
          }),
        },
      },
    })
    // Last, so the audit trail reads in write order: the replay settles how
    // the deposit splits between charges and the schedule.
    if (chargesOn && !fullyUnapplied) {
      await syncLoanCharges(tx, chargesRef, asOf, {
        source: "bank_sync",
        userId: args.userId ?? null,
        userEmail: args.userEmail,
      })
    }
    await tx.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE")
    return payment.id
  }).catch(async (error: unknown) => {
    if (!(error instanceof ChargesError)) throw error
    // The deposit is real money: when the charges replay refuses it, hold it
    // for reconciliation (linked to this statement line) rather than drop it.
    return await prisma.$transaction(async (tx) => {
      await lockLoanForUpdate(tx, args.loanId)
      const claim = await tx.bankTransaction.updateMany({
        where: { id: txn.id, tenantId: args.tenantId, matchStatus: { in: ["PROPOSED", "UNMATCHED"] } },
        data: { matchStatus: "MATCHED" },
      })
      if (claim.count !== 1) throw new InvalidLoanStateError("Transaction already reconciled or ignored")
      const held = await recordHeldReceipt(tx, {
        tenantId: args.tenantId, loanId: args.loanId, amount: txn.amountCents, paymentMethod: "EFT",
        reference: txn.rawReference, notes: "Reconciled from ABSA statement — held for reconciliation",
        receivedAt, capturedBy, error, source: "bank_sync", userId: args.userId ?? null, userEmail: args.userEmail,
      })
      await tx.bankTransaction.update({
        where: { id: txn.id },
        data: { paymentId: held.id, matchedLoanId: args.loanId, reviewedBy: args.userId ?? null, reviewedAt: asOf },
      })
      return held.id
    })
  })

  return { paymentId }
  })
}

export async function ignoreBankTransaction(args: {
  txnId: string
  tenantId: string
  userId: string
  userEmail: string
  reason: string
}): Promise<void> {
  return runWithTenant(args.tenantId, async () => {
  const txn = await prisma.bankTransaction.findFirst({
    where: { id: args.txnId, tenantId: args.tenantId },
  })
  if (!txn) throw new TransactionNotFoundError("Bank transaction not found")

  // Atomically flip PROPOSED/UNMATCHED → IGNORED. If a concurrent applyBank-
  // Transaction already MATCHED this row (booking a real Payment), the guarded
  // updateMany matches 0 rows and we abort — never leaving a row that reads
  // IGNORED while it still points at a posted Payment.
  const claimed = await prisma.bankTransaction.updateMany({
    where: {
      id: txn.id,
      tenantId: args.tenantId,
      matchStatus: { in: ["PROPOSED", "UNMATCHED"] },
    },
    data: {
      matchStatus: "IGNORED",
      ignoreReason: args.reason,
      reviewedBy: args.userId,
      reviewedAt: new Date(),
    },
  })
  if (claimed.count !== 1) {
    throw new InvalidLoanStateError("Transaction is no longer available to ignore")
  }

  await logAudit({
    tenantId: args.tenantId,
    userId: args.userId,
    userEmail: args.userEmail,
    action: AuditAction.BANK_TXN_IGNORED,
    entity: "BankTransaction",
    entityId: txn.id,
    newValue: { reason: args.reason },
  })
  })
}
