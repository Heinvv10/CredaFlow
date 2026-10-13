/**
 * triggerNotification() (lib/notifications.ts) for a loan whose borrower is a
 * business entity. The consumer path resolves the loan's `Client` and addresses
 * them as the borrower; an entity loan has no `Client`, so its loan-level
 * events go to the entity's directors, trustees and authorised signatories
 * (./entity-contacts.ts) with the entity-naming copy (./entity-notices.ts).
 *
 * Covered: `payment_received` (every receipt path: staff capture, reconcile,
 * the Stitch webhook) and `loan_overdue` (the collections reminder cron).
 * Every other event returns false and keeps the consumer behaviour: the
 * application events are not raised for an asset deal, and `section129_sent`
 * never applies to a NON_NCA agreement.
 *
 * Each leg writes a NotificationLog row with the recipient's clientId, as the
 * consumer path does, so the staff and portal notification pages show them.
 */
import { prisma } from "@/lib/prisma"
import { getLenderIdentity } from "@/lib/config/identity"
import { sastCalendarDate } from "@/lib/date/sast"
import { entityContactRecipients } from "./entity-contacts"
import { sendEntityNotice, type EntityChannel, type EntityLegOutcome } from "./entity-dispatch"
import type { EntityNoticeFacts } from "./entity-notices"

export interface EntityNotificationOptions {
  tenantId: string
  event: string
  loanId?: string
  data?: Record<string, unknown>
  suppressWhatsAppReason?: string
}

export type NotificationLogWriter = (row: {
  loanId?: string
  clientId?: string
  event: string
  channel: string
  status: string
  error?: string
  messageId?: string
}) => Promise<void>

const LOG_STATUS: Record<EntityLegOutcome["status"], string> = {
  sent: "sent",
  simulated: "simulated",
  pending: "pending",
  reconciliation: "reconciliation_required",
  blocked: "blocked",
  skipped: "blocked",
  failed: "failed",
}

/** True when the loan is an entity loan and this handled the event (sent or logged why not). */
export async function notifyEntityBorrower(opts: EntityNotificationOptions, log: NotificationLogWriter): Promise<boolean> {
  if (!opts.loanId || (opts.event !== "payment_received" && opts.event !== "loan_overdue")) return false
  const loan = await prisma.loan.findFirst({
    where: { id: opts.loanId, tenantId: opts.tenantId },
    select: {
      id: true, reference: true, entityId: true,
      entity: { select: { legalName: true } },
      repaymentSchedule: { select: { totalDue: true, totalPaid: true } },
    },
  })
  if (!loan?.entityId || !loan.entity) return false
  const base = { loanId: loan.id, event: opts.event }

  const paymentId = typeof opts.data?.paymentId === "string" ? opts.data.paymentId.trim() : ""
  if (opts.event === "payment_received" && !paymentId) {
    // Two equal receipts are two notices; without the Payment id they cannot
    // be told apart, so nothing is sent rather than one being swallowed.
    await log({ ...base, channel: "all", status: "failed", error: "paymentId is required for an entity receipt notice" })
    return true
  }
  const recipients = await entityContactRecipients(prisma, opts.tenantId, loan.entityId)
  if (recipients.length === 0) {
    await log({ ...base, channel: "all", status: "failed", error: "The entity has no active director, trustee or authorised signatory to notify" })
    return true
  }

  // Fails closed, as the consumer path does: no notice signed by no lender.
  const identity = await getLenderIdentity(opts.tenantId)
  const amountCents = Number(opts.data?.amount ?? 0)
  const outstandingCents = loan.repaymentSchedule.reduce((sum, row) => sum + Math.max(0, row.totalDue - row.totalPaid), 0)
  const facts: EntityNoticeFacts = opts.event === "payment_received"
    ? { kind: "received", entityName: loan.entity.legalName, reference: loan.reference, amountCents, outstandingCents }
    : { kind: "overdue", entityName: loan.entity.legalName, reference: loan.reference, amountCents, daysOverdue: Number(opts.data?.daysOverdue ?? 0) || undefined }

  const channels: EntityChannel[] = opts.suppressWhatsAppReason ? ["EMAIL"] : ["EMAIL", "WHATSAPP"]
  const outcomes = await sendEntityNotice({
    tenantId: opts.tenantId,
    loanId: loan.id,
    facts,
    lender: { tradingName: identity.tradingName, collectionsPhone: identity.collectionsPhone },
    recipients,
    channels,
    // A receipt is its own occurrence; dunning may repeat on a later day only.
    occurrence: opts.event === "payment_received" ? `payment_received:${paymentId}` : `loan_overdue:${sastCalendarDate(new Date())}`,
    category: opts.event,
  })
  for (const o of outcomes) {
    await log({ ...base, clientId: o.clientId, channel: o.channel.toLowerCase(), status: LOG_STATUS[o.status], error: o.reason, messageId: o.messageId })
  }
  if (opts.suppressWhatsAppReason) {
    for (const r of recipients) {
      await log({ ...base, clientId: r.clientId, channel: "whatsapp", status: "blocked", error: opts.suppressWhatsAppReason })
    }
  }
  return true
}
