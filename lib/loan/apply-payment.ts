import { Prisma, type PaymentMethod } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { AuditAction } from "@/lib/audit"
import { recomputeLoanBalances, nextPaymentDueDate } from "@/lib/loan/balances"
import { lockLoanForUpdate } from "@/lib/loan/lock"
import { CHARGES_FLAG_INCLUDE, chargesEnabled } from "@/lib/loan/charges-replay"
import { projectChargeAwareReceipt } from "@/lib/loan/charge-aware-receipt"
import { syncLoanCharges } from "@/lib/loan/charges-sync"
import { closingValueDate } from "@/lib/loan/receipt-charges"
import { restampSchedulePaidAt } from "@/lib/loan/schedule-paid-at"
import {
  isSameReceiptRequest,
  OVERPAYMENT_REASON,
} from "@/lib/loan/receipt-rules"
import {
  rejectImpossibleValueDate,
  rejectUnauthorisedBackdating,
  valueDateEvidence,
  VALUE_DATE_MESSAGES,
  type ValueDateOverride,
} from "@/lib/loan/value-date"
import {
  backdatingInterestRebate,
  receiptContractualTotalsUpdate,
  settlementAuditEvidence,
} from "@/lib/loan/settlement"

export type PaymentErrorCode =
  | "NOT_FOUND"
  | "NOT_ACTIVE"
  | "INVALID_VALUE_DATE"
  | "IDEMPOTENCY_CONFLICT"

/**
 * Domain error thrown by applyManualReceipt so the HTTP layer can map each
 * cause to the right status (404 / 400 / 422) without leaking Prisma details.
 */
export class PaymentApplicationError extends Error {
  readonly code: PaymentErrorCode
  constructor(code: PaymentErrorCode, message: string) {
    super(message)
    this.name = "PaymentApplicationError"
    this.code = code
  }
}

export interface ManualReceiptInput {
  loanId: string
  tenantId: string
  /** cents; the caller must have validated this is a positive integer */
  amount: number
  paymentMethod?: string
  reference?: string | null
  notes?: string | null
  capturedById: string
  capturedByEmail?: string | null
  idempotencyKey?: string
  /**
   * Date the money reached us. Defaults to now. Interest accrues to THIS, not
   * to capture time — capturing a week-old deposit must not bill the client a
   * week of credit they never had (NCA s125(2)(b)).
   */
  receivedAt?: Date
  /**
   * Required to date a receipt further back than the staff window. Recorded in
   * the audit alongside the interest it rebated.
   */
  valueDateOverride?: ValueDateOverride | null
}

/**
 * The transaction runner applyManualReceipt needs. `Pick<typeof prisma, …>`
 * captures the tenant-scope-extended client's exact `$transaction` type, so the
 * real caller passes the singleton with no cast (matches the codebase
 * convention in lib/messaging/types.ts and lib/consent.ts). Tests pass a plain
 * PrismaClient cast to this type.
 */
export type PaymentDb = Pick<typeof prisma, "$transaction">

/**
 * Record a manual receipt against a loan and re-derive its balances, atomically.
 *
 * The whole read-modify-write runs inside one transaction that FIRST takes a
 * `FOR UPDATE` lock on the loan (see lockLoanForUpdate) so concurrent receipts
 * serialise instead of racing on a stale balance. The settlement
 * split is computed against the freshly-locked balance, so two concurrent
 * payments can't each pass the "within settlement" check and jointly
 * over-collect.
 */
export async function applyManualReceipt(db: PaymentDb, input: ManualReceiptInput) {
  return db.$transaction(async (tx) => {
    const paymentMethod = (input.paymentMethod || "EFT") as PaymentMethod
    const reference = input.reference ?? null
    const notes = input.notes ?? null

    if (input.idempotencyKey) {
      // A per-key lock closes the cross-loan race a per-loan lock cannot: two
      // requests reusing one key for different loans must serialise before
      // either checks/inserts the unique Payment key.
      await tx.$executeRaw(Prisma.sql`
        SELECT pg_advisory_xact_lock(
          hashtextextended(${`${input.tenantId}:${input.idempotencyKey}`}, 0)
        )
      `)

      const existing = await tx.payment.findUnique({
        where: {
          tenantId_idempotencyKey: {
            tenantId: input.tenantId,
            idempotencyKey: input.idempotencyKey,
          },
        },
        include: { excessPayments: true },
      })
      if (existing) {
        if (!isSameReceiptRequest(existing, { ...input, paymentMethod, reference, notes })) {
          throw new PaymentApplicationError(
            "IDEMPOTENCY_CONFLICT",
            "This idempotency key was already used for a different payment request.",
          )
        }
        return {
          payment: existing,
          // A replay must still report what is owed back, or the capture screen
          // silently drops the refund on the retry.
          excessPayment: (existing.excessPayments ?? [])[0] ?? null,
          idempotentReplay: true as const,
        }
      }
    }

    await lockLoanForUpdate(tx, input.loanId)

    const loan = await tx.loan.findUnique({
      where: { id: input.loanId, tenantId: input.tenantId },
      include: {
        repaymentSchedule: { orderBy: [{ dueDate: "asc" }, { installmentNo: "asc" }] },
        tenant: CHARGES_FLAG_INCLUDE,
      },
    })
    if (!loan) throw new PaymentApplicationError("NOT_FOUND", "Loan not found")
    if (!["ACTIVE", "DEFAULTED"].includes(loan.status)) {
      throw new PaymentApplicationError("NOT_ACTIVE", "Loan is not active")
    }

    const asOf = new Date()
    const receivedAt = input.receivedAt ?? asOf
    const rejection = rejectImpossibleValueDate({
      receivedAt,
      asOf,
      loanStartDate: loan.startDate,
    })
    if (rejection) {
      throw new PaymentApplicationError(
        "INVALID_VALUE_DATE",
        VALUE_DATE_MESSAGES[rejection],
      )
    }

    // Money that has already arrived is always recorded; anything above the
    // s125 settlement amount is split off as refund-due rather than collected.
    const chargesRef = { tenantId: input.tenantId, loanId: input.loanId }
    const chargesOn = chargesEnabled(loan)
    // Priced at the value date: that is the settlement date for s125(2)(b).
    // `asOf` stays NOW for arrears/DPD, which must describe today even on a
    // back-dated receipt.
    const { projection, chargesBackdating } = await projectChargeAwareReceipt(tx, {
      loan,
      schedule: loan.repaymentSchedule,
      amount: input.amount,
      receivedAt,
      asOf,
      allowOverpayment: true,
    })

    // Back-dating writes off interest. Bounded by what it COSTS rather than by
    // how many days it spans — a fixed window is 46.7% of the interest on a
    // 30-day product and a rounding error on a 120-day one. Checked before any
    // write, so an unauthorised rebate leaves no trace of a receipt.
    // Only the portion the DATE created, not the lawful early-settlement rebate
    // any client earns by paying before maturity.
    const backdating = backdatingInterestRebate({
      loan, schedule: loan.repaymentSchedule, asOf, receivedAt,
    })
    // Default charges erased by the date count too (rejectUnauthorisedBackdating).
    const rebateRejection = rejectUnauthorisedBackdating({
      interest: backdating,
      charges: chargesBackdating,
      override: input.valueDateOverride ?? null,
    })
    if (rebateRejection) {
      throw new PaymentApplicationError(
        "INVALID_VALUE_DATE",
        VALUE_DATE_MESSAGES[rebateRejection],
      )
    }

    // Nothing owed → no allocated portion; the whole receipt is refund-due and
    // must not touch the schedule or the loan's balances.
    //
    // KNOWN GAP: the ACTIVE/DEFAULTED guard above fires first, so a genuinely
    // COMPLETED loan never reaches here — a client over-paying a closed loan
    // still gets "Loan is not active" and the money stays unrecorded, which is
    // the very defect the split exists to fix. This branch currently only
    // covers legacy or manually-repaired rows that are ACTIVE with nothing
    // outstanding. Widening the status guard is a separate money-path decision
    // and is deliberately NOT bundled here.
    const fullyUnapplied = projection.appliedAmount === 0

    const common = {
      tenantId: input.tenantId,
      loanId: input.loanId,
      paymentMethod,
      reference,
      notes,
      receivedAt,
      capturedBy: input.capturedById,
    }
    const refundDue = { allocationStatus: "UNAPPLIED" as const, reconciliationReason: OVERPAYMENT_REASON }

    const newPayment = await tx.payment.create({
      data: {
        ...common,
        amount: fullyUnapplied ? input.amount : projection.appliedAmount,
        idempotencyKey: input.idempotencyKey,
        ...(fullyUnapplied ? refundDue : {}),
      },
    })

    const excessPayment = !fullyUnapplied && projection.excessAmount > 0
      ? await tx.payment.create({
          data: {
            ...common,
            ...refundDue,
            amount: projection.excessAmount,
            parentPaymentId: newPayment.id,
          },
        })
      : null

    // For DAILY_ACCRUAL, a full early settlement reduces only unearned interest
    // and rewrites the bullet row to the lawful settlement total.
    const postRows = projection.rows
    const isCompleted = projection.isCompleted
    let closedAt = loan.closedAt

    if (!fullyUnapplied) {
      for (let i = 0; i < postRows.length; i++) {
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
      // A receipt dated before one already on the loan changes which receipt
      // completed rows the loop skipped: re-date every row from the replay.
      if (!chargesOn) {
        await restampSchedulePaidAt(tx, chargesRef, {
          source: "manual_capture", userId: input.capturedById, userEmail: input.capturedByEmail ?? null,
        })
      }

      // Recompute principal + arrears + DPD from the post-payment schedule
      //. Arrears describe TODAY, so this stays on `asOf` even
      // when the receipt is back-dated.
      const balances = recomputeLoanBalances(loan.principal, postRows, asOf)
      closedAt = isCompleted ? await closingValueDate(tx, input.loanId, receivedAt) : loan.closedAt

      await tx.loan.update({
        where: { id: input.loanId, tenantId: input.tenantId },
        data: {
          totalPaid: projection.newTotalPaid,
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
          // The allocated portion only. Refund-due money was never collected.
          lastPaymentAmount: projection.appliedAmount,
          nextPaymentDate: nextPaymentDueDate(postRows),
          // A partial payment doesn't cure a default on its own; only full
          // settlement changes status here.
          status: isCompleted ? "COMPLETED" : loan.status,
          closedAt,
          daysInArrears: balances.daysInArrears,
          arrearsAmount: balances.arrearsAmount,
        },
      })
    }

    await tx.auditLog.create({
      data: {
        tenantId: input.tenantId,
        userId: input.capturedById,
        userEmail: input.capturedByEmail ?? null,
        action: AuditAction.PAYMENT_RECORDED,
        entity: "Loan",
        entityId: input.loanId,
        newValue: {
          paymentId: newPayment.id,
          amount: input.amount,
          method: paymentMethod,
          reference,
          ...valueDateEvidence({
            receivedAt,
            asOf,
            source: "STAFF_ASSERTED",
            interestRebateCents: backdating.rebateCents + chargesBackdating.rebateCents,
            defaultChargesRebateCents: chargesBackdating.rebateCents,
            override: input.valueDateOverride ?? null,
          }),
          // The split is the audit-relevant fact: how much of the money the
          // client tendered was lawfully collected, and how much is owed back.
          appliedAmount: projection.appliedAmount,
          excessAmount: projection.excessAmount,
          excessPaymentId: excessPayment?.id ?? null,
          idempotencyKey: input.idempotencyKey ?? null,
          ...settlementAuditEvidence(projection),
        },
      },
    })

    if (isCompleted && loan.status !== "COMPLETED") {
      await tx.auditLog.create({
        data: {
          tenantId: input.tenantId,
          userId: input.capturedById,
          userEmail: input.capturedByEmail ?? null,
          action: AuditAction.LOAN_STATUS_CHANGED,
          entity: "Loan",
          entityId: input.loanId,
          oldValue: { status: loan.status, closedAt: loan.closedAt?.toISOString() ?? null },
          newValue: {
            status: "COMPLETED",
            // The value date, matching what was written to Loan.closedAt in
            // this same transaction. Writing the wall clock here made the audit
            // trail disagree with the row it describes on every back-dated
            // settlement, with nothing explaining the difference.
            closedAt: closedAt?.toISOString() ?? null,
            reason: "settled_by_payment",
            paymentId: newPayment.id,
            earlyDailySettlement: projection.isEarlyDailySettlement,
            accruedInterest: projection.accruedInterest,
            interestRebate: projection.interestRebate,
          },
        },
      })
    }

    // The replay is the authority on how the receipt splits between charges
    // and the schedule; it runs last so the audit trail reads in write order.
    const synced = chargesOn && !fullyUnapplied
      ? await syncLoanCharges(tx, chargesRef, asOf, {
          source: "manual_capture",
          userId: input.capturedById,
          userEmail: input.capturedByEmail ?? null,
        })
      : null

    // Deferred PASQ/ledger guards can fail at COMMIT after PostgreSQL has
    // already returned the created receipt row. Force them inside the callback
    // so Prisma cannot surface a rolled-back payment as an HTTP 200.
    await tx.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE")

    // The replay rewrote this receipt's charge split; hand back that row.
    const payment = synced
      ? await tx.payment.findUniqueOrThrow({ where: { id: newPayment.id, tenantId: input.tenantId } })
      : newPayment
    return { payment, excessPayment, idempotentReplay: false as const }
  })
}
