/**
 * Books a mobile-money payment through the EXISTING receipt path,
 * applyManualReceiptInTx (lib/loan/apply-payment.ts): the same loan lock, s125
 * settlement split, schedule update, charges replay and PAYMENT_RECORDED audit
 * as a staff capture. Nothing here allocates money itself.
 *
 * Exactly once: the receipt and the MobileMoneyTransaction row that names it
 * commit in one transaction. A second delivery of the same provider
 * transaction fails on UNIQUE(provider, transId) (or finds the push no longer
 * PENDING) and rolls back everything it did, so it books nothing. The receipt's
 * idempotency key, `mpesa-c2b:<TransID>`, is the second guard.
 *
 * Money that arrived is never dropped: a refusal by the charges replay holds it
 * UNAPPLIED (lib/payments/held-receipt.ts); any other refusal of the money path
 * (loan closed, value date) leaves it NEEDS_REVIEW for a person.
 */
import { Prisma } from "@prisma/client"
import type { prisma } from "@/lib/prisma"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { applyManualReceiptInTx, PaymentApplicationError, type ManualReceiptInput, type PaymentTx } from "@/lib/loan/apply-payment"
import { ChargesError } from "@/lib/loan/charges-error"
import { lockLoanForUpdate } from "@/lib/loan/lock"
import { recordHeldReceipt } from "@/lib/payments/held-receipt"
import { notifyReceiptBooked } from "./notify"

export type MobileMoneyDb = Pick<typeof prisma, "$transaction" | "$queryRaw" | "mobileMoneyTransaction">

/** The machine actor on ingested receipts. AuditLog.userId is a User FK, so it stays null. */
export const MOBILE_MONEY_ACTOR = { userEmail: "system@mobile-money", capturedBy: "mobile-money" } as const

export type IngestOutcome =
  | { outcome: "BOOKED" | "HELD"; transactionId: string; paymentId: string }
  | { outcome: "UNMATCHED" | "NEEDS_REVIEW" | "CANCELLED"; transactionId: string }
  | { outcome: "DUPLICATE" }
  | { outcome: "UNKNOWN_REQUEST" }

/** The row's final state, once the money's fate is known. */
export type Settled =
  | { status: "BOOKED" | "HELD"; paymentId: string }
  /** reportedAmount: what the provider says was paid, where it differs from the push's amount. */
  | { status: "NEEDS_REVIEW"; reviewReason: string; reportedAmount?: number }
  | { status: "UNMATCHED" }
  | { status: "CANCELLED"; reason: string }

/**
 * Writes the row's final state (create for a paybill payment, claim of the
 * PENDING push for an STK result) and its audit, inside the caller's
 * transaction. Returns the row id; throws DuplicateDelivery when another
 * delivery already settled it.
 */
export type Settle = (tx: PaymentTx, settled: Settled) => Promise<string>

export class DuplicateDelivery extends Error {
  constructor() {
    super("This mobile-money transaction was already recorded")
    this.name = "DuplicateDelivery"
  }
}

/** The money's value date: when the provider says it moved, never later than now. */
export function valueDate(transactedAt: Date | null, now: Date): Date {
  return transactedAt && transactedAt < now ? transactedAt : now
}

/** Another delivery of the same provider transaction won: nothing of this one may commit. */
function isDuplicate(error: unknown): boolean {
  if (error instanceof DuplicateDelivery) return true
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002"
    && String(error.meta?.target ?? "").includes("transId")
}

const AUDIT_ACTIONS = {
  BOOKED: AuditAction.MOBILE_MONEY_RECEIPT_BOOKED,
  HELD: AuditAction.MOBILE_MONEY_RECEIPT_HELD,
  UNMATCHED: AuditAction.MOBILE_MONEY_UNMATCHED,
  NEEDS_REVIEW: AuditAction.MOBILE_MONEY_NEEDS_REVIEW,
  CANCELLED: AuditAction.MOBILE_MONEY_STK_CANCELLED,
} as const

/** The audit row for a settled transaction. No phone digits and no account reference: only ids and money. */
export async function auditSettled(tx: PaymentTx, args: {
  tenantId: string; transactionId: string; provider: string; transId: string | null
  amount: number; loanId: string | null; simulated: boolean; settled: Settled
}): Promise<void> {
  const { settled } = args
  await logAuditStrict({
    tenantId: args.tenantId, userEmail: MOBILE_MONEY_ACTOR.userEmail,
    action: AUDIT_ACTIONS[settled.status], entity: "MobileMoneyTransaction", entityId: args.transactionId,
    newValue: {
      provider: args.provider, transId: args.transId, amount: args.amount, loanId: args.loanId, simulated: args.simulated,
      status: settled.status,
      ...("paymentId" in settled ? { paymentId: settled.paymentId } : {}),
      ...("reviewReason" in settled ? { reason: settled.reviewReason } : {}),
      ...("reportedAmount" in settled ? { reportedAmount: settled.reportedAmount } : {}),
      ...("reason" in settled ? { reason: settled.reason } : {}),
    },
  }, tx)
}

/** Settle a transaction that books no money (unmatched, cancelled, waiting for a person). */
export async function settleWithoutReceipt(db: MobileMoneyDb, settle: Settle, settled: Exclude<Settled, { paymentId: string }>): Promise<IngestOutcome> {
  try {
    const transactionId = await db.$transaction((tx) => settle(tx, settled))
    return { outcome: settled.status, transactionId }
  } catch (error) {
    if (isDuplicate(error)) return { outcome: "DUPLICATE" }
    throw error
  }
}

export interface MobileMoneyPayment {
  tenantId: string; loanId: string; amountCents: number; transId: string; receivedAt: Date; simulated: boolean
}

const receiptNotes = (simulated: boolean) => simulated ? "SIMULATED M-Pesa payment: no money moved" : "M-Pesa payment"

/**
 * The receipt an M-Pesa transaction books, whoever books it (the ingest, or
 * staff allocating one that waited): one idempotency key per transaction.
 */
export function mobileMoneyReceipt(
  payment: MobileMoneyPayment,
  actor: { capturedById: string; capturedByEmail: string | null; auditUserId: string | null } = {
    capturedById: MOBILE_MONEY_ACTOR.capturedBy, capturedByEmail: MOBILE_MONEY_ACTOR.userEmail, auditUserId: null,
  },
): ManualReceiptInput {
  return {
    loanId: payment.loanId,
    tenantId: payment.tenantId,
    amount: payment.amountCents,
    paymentMethod: "MOBILE_MONEY",
    reference: payment.transId,
    notes: receiptNotes(payment.simulated),
    ...actor,
    idempotencyKey: `mpesa-c2b:${payment.transId}`,
    receivedAt: payment.receivedAt,
    valueDateSource: "SYSTEM_OBSERVED",
  }
}

export async function bookReceipt(db: MobileMoneyDb, payment: MobileMoneyPayment, settle: Settle): Promise<IngestOutcome> {
  const notes = receiptNotes(payment.simulated)
  try {
    const booked = await db.$transaction(async (tx) => {
      const receipt = await applyManualReceiptInTx(tx, mobileMoneyReceipt(payment))
      const transactionId = await settle(tx, { status: "BOOKED", paymentId: receipt.payment.id })
      return { transactionId, payment: receipt.payment }
    })
    // After the commit: a rolled-back receipt must never be announced.
    notifyReceiptBooked({ tenantId: payment.tenantId, loanId: payment.loanId, payment: booked.payment })
    return { outcome: "BOOKED", transactionId: booked.transactionId, paymentId: booked.payment.id }
  } catch (error) {
    if (isDuplicate(error)) return { outcome: "DUPLICATE" }
    if (error instanceof PaymentApplicationError) {
      return await settleWithoutReceipt(db, settle, { status: "NEEDS_REVIEW", reviewReason: `Receipt not booked (${error.code}): ${error.message}` })
    }
    if (!(error instanceof ChargesError)) throw error
    // The money arrived: when the charges replay refuses it, hold it for reconciliation.
    try {
      return await db.$transaction(async (tx) => {
        await lockLoanForUpdate(tx, payment.loanId)
        const held = await recordHeldReceipt(tx, {
          tenantId: payment.tenantId, loanId: payment.loanId, amount: payment.amountCents, paymentMethod: "MOBILE_MONEY",
          reference: payment.transId, notes: `${notes}, held for reconciliation`, receivedAt: payment.receivedAt,
          capturedBy: MOBILE_MONEY_ACTOR.capturedBy, error, source: "mobile_money", userEmail: MOBILE_MONEY_ACTOR.userEmail,
        })
        const transactionId = await settle(tx, { status: "HELD", paymentId: held.id })
        return { outcome: "HELD" as const, transactionId, paymentId: held.id }
      })
    } catch (heldError) {
      if (isDuplicate(heldError)) return { outcome: "DUPLICATE" }
      throw heldError
    }
  }
}
