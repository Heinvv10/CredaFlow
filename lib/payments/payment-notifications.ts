import { Prisma } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { hasMinRole, ROLE_HIERARCHY, type UserRole } from "@/lib/permissions"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import {
  applyManualReceiptInTx,
  type ManualReceiptInput,
  type PaymentDb,
  type PaymentTx,
} from "@/lib/loan/apply-payment"
import type { NotificationType } from "@/lib/notifications/bell"
import { formatZAR } from "@/lib/utils"

/**
 * Client-notified payments (Fair Score audit B7). A borrower's portal "I have
 * paid" report is a claim with proof attached, not a receipt: it is listed on
 * the Payments page as awaiting reconciliation until staff either allocate it
 * (a real receipt is captured, exactly as Record Payment would) or reject it.
 * The CHECK in migration 20261016150000_payment_notifications keeps the status
 * and the resolution columns in step.
 */

/**
 * Who may allocate or reject a report: the same minimum as capturing a payment
 * (POST /api/payments). The route, the bell and the Payments page all read
 * this, so nobody is alerted to an item they cannot act on. To be replaced by
 * the explicit payment-capture permission (Fair Score workstream C4).
 */
export const PAYMENT_NOTIFICATION_MIN_ROLE: UserRole = "COLLECTIONS_AGENT"
const ALERTED_ROLES = ROLE_HIERARCHY.filter((role) => hasMinRole(role, PAYMENT_NOTIFICATION_MIN_ROLE))

export function canActOnPaymentNotifications(role: string | null | undefined): boolean {
  return typeof role === "string" && hasMinRole(role as UserRole, PAYMENT_NOTIFICATION_MIN_ROLE)
}

export const REJECT_REASON_MAX = 500

export class PaymentNotificationError extends Error {
  constructor(readonly code: "NOT_FOUND" | "ALREADY_RESOLVED", message: string) {
    super(message)
    this.name = "PaymentNotificationError"
  }
}

export interface PaymentNotificationClaim {
  tenantId: string
  loanId: string
  loanReference: string
  clientId: string
  clientName: string
  /** cents */
  amount: number
  reference: string | null
  paymentDate: Date | null
  notes: string | null
  /** The proof of payment ClientDocument. */
  documentId: string
  actorEmail: string | null
  ipAddress: string | null
}

/**
 * Records the claim, its audit row and a bell item for each reconciling staff
 * member, in the caller's transaction (the portal route's, so the proof, the
 * loan note and the claim commit together).
 */
export async function recordPaymentNotification(tx: PaymentTx, claim: PaymentNotificationClaim): Promise<{ id: string }> {
  const created = await tx.paymentNotification.create({
    data: {
      tenantId: claim.tenantId,
      loanId: claim.loanId,
      clientId: claim.clientId,
      amount: claim.amount,
      reference: claim.reference,
      paymentDate: claim.paymentDate,
      notes: claim.notes,
      documentId: claim.documentId,
    },
    select: { id: true },
  })
  await logAuditStrict({
    tenantId: claim.tenantId,
    userEmail: claim.actorEmail ?? undefined,
    action: AuditAction.PAYMENT_NOTIFICATION_RECEIVED,
    entity: "PaymentNotification",
    entityId: created.id,
    newValue: {
      loanId: claim.loanId, loanReference: claim.loanReference, clientId: claim.clientId,
      amountCents: claim.amount, documentId: claim.documentId,
    },
    ipAddress: claim.ipAddress ?? undefined,
  }, tx)
  const staff = await tx.user.findMany({
    where: { tenantId: claim.tenantId, active: true, role: { in: [...ALERTED_ROLES] } },
    select: { id: true },
  })
  await tx.notification.createMany({
    data: staff.map((user) => ({
      tenantId: claim.tenantId,
      userId: user.id,
      type: "PAYMENT_NOTIFIED" satisfies NotificationType,
      title: `${claim.clientName} reported a payment of ${formatZAR(claim.amount)}`,
      body: `On loan ${claim.loanReference}, with proof of payment. Allocate or reject it under Payments → Awaiting reconciliation.`,
      entityType: "PaymentNotification",
      entityId: created.id,
    })),
  })
  return created
}

/** Every unanswered report for the Payments page, oldest first. */
export function listPendingPaymentNotifications(tenantId: string) {
  return prisma.paymentNotification.findMany({
    where: { tenantId, status: "PENDING" },
    orderBy: { createdAt: "asc" },
    select: {
      id: true, amount: true, reference: true, paymentDate: true, notes: true, documentId: true, createdAt: true,
      loan: { select: { id: true, reference: true } },
      client: { select: { firstName: true, lastName: true } },
    },
  })
}

async function lockPending(tx: PaymentTx, tenantId: string, id: string) {
  await tx.$queryRaw(Prisma.sql`
    SELECT "id" FROM "PaymentNotification" WHERE "id" = ${id} AND "tenantId" = ${tenantId} FOR UPDATE
  `)
  const notification = await tx.paymentNotification.findUnique({
    where: { id, tenantId },
    include: { loan: { select: { reference: true } } },
  })
  if (!notification) throw new PaymentNotificationError("NOT_FOUND", "Payment notification not found")
  if (notification.status !== "PENDING") {
    throw new PaymentNotificationError("ALREADY_RESOLVED", `This payment notification was already ${notification.status.toLowerCase()}`)
  }
  return notification
}

export interface AllocateInput {
  tenantId: string
  id: string
  actor: { id: string; email: string | null }
  /** cents; defaults to the amount the client reported */
  amount?: number
  /** When the money reached the lender; defaults to the client's payment date. */
  receivedAt?: Date
  paymentMethod?: string
  valueDateOverride?: ManualReceiptInput["valueDateOverride"]
}

/**
 * Captures the reported payment as a receipt and marks the notification
 * allocated to it, atomically. The receipt's idempotency key is the
 * notification's id, so the same report can never become two receipts.
 */
export async function allocatePaymentNotification(db: PaymentDb, input: AllocateInput) {
  return db.$transaction(async (tx) => {
    const notification = await lockPending(tx, input.tenantId, input.id)
    const amount = input.amount ?? notification.amount
    const receipt = await applyManualReceiptInTx(tx, {
      loanId: notification.loanId,
      tenantId: input.tenantId,
      amount,
      paymentMethod: input.paymentMethod ?? "EFT",
      reference: notification.reference,
      notes: `Client-notified payment ${notification.id}`,
      receivedAt: input.receivedAt ?? notification.paymentDate ?? undefined,
      // Who dated the receipt: staff when they entered a date, else the client's report.
      valueDateSource: !input.receivedAt && notification.paymentDate ? "CLIENT_ASSERTED" : "STAFF_ASSERTED",
      valueDateOverride: input.valueDateOverride ?? null,
      capturedById: input.actor.id,
      capturedByEmail: input.actor.email,
      idempotencyKey: `payment-notification:${notification.id}`,
    })
    const resolvedAt = new Date()
    await tx.paymentNotification.update({
      where: { id: notification.id, tenantId: input.tenantId },
      data: { status: "ALLOCATED", paymentId: receipt.payment.id, resolvedById: input.actor.id, resolvedAt },
    })
    await logAuditStrict({
      tenantId: input.tenantId,
      userId: input.actor.id,
      userEmail: input.actor.email ?? undefined,
      action: AuditAction.PAYMENT_NOTIFICATION_ALLOCATED,
      entity: "PaymentNotification",
      entityId: notification.id,
      oldValue: { status: "PENDING", reportedAmountCents: notification.amount },
      newValue: { status: "ALLOCATED", paymentId: receipt.payment.id, amountCents: amount, loanReference: notification.loan.reference },
    }, tx)
    return { notification: { ...notification, status: "ALLOCATED" as const }, ...receipt }
  })
}

/** Records that staff found no such payment, with the reason, and who decided. */
export async function rejectPaymentNotification(
  db: PaymentDb,
  input: { tenantId: string; id: string; actor: { id: string; email: string | null }; reason: string },
) {
  return db.$transaction(async (tx) => {
    const notification = await lockPending(tx, input.tenantId, input.id)
    await tx.paymentNotification.update({
      where: { id: notification.id, tenantId: input.tenantId },
      data: { status: "REJECTED", rejectReason: input.reason, resolvedById: input.actor.id, resolvedAt: new Date() },
    })
    await logAuditStrict({
      tenantId: input.tenantId,
      userId: input.actor.id,
      userEmail: input.actor.email ?? undefined,
      action: AuditAction.PAYMENT_NOTIFICATION_REJECTED,
      entity: "PaymentNotification",
      entityId: notification.id,
      oldValue: { status: "PENDING" },
      newValue: { status: "REJECTED", reason: input.reason, loanReference: notification.loan.reference },
    }, tx)
    return { id: notification.id, status: "REJECTED" as const }
  })
}
