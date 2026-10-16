import { SMS_CHANNEL_OFF_REASON } from "@/lib/messaging/sms-channel"

/**
 * What a borrower is told about a message we sent them. NotificationLog.status
 * is an internal delivery/reconciliation state ("review_required" and
 * "reconciliation_required" mean the provider's answer is not yet matched to
 * the message; "blocked" can mean a consent suppression). None of that is the
 * borrower's business, and showing it made a working account look broken (Fair
 * Score audit 2026-10-16). The row itself is unchanged for staff and the audit
 * trail.
 *
 * Only a confirmed send reads "Sent": a state still being reconciled is
 * "Pending", never claimed as delivered.
 */
export type BorrowerNotificationStatus = "sent" | "not_delivered" | "pending" | "simulated"

/**
 * Every status the NotificationLog writers produce: lib/notifications.ts and
 * lib/notifications/status.ts, lib/messaging/dispatch-control.ts,
 * lib/messaging/retry.ts, lib/messaging/reconcile-held-message.ts,
 * lib/messaging/staff-task-reminder.ts and the renewal/licence crons.
 */
export const BORROWER_NOTIFICATION_STATUS: Readonly<Record<string, BorrowerNotificationStatus>> = {
  sent: "sent",
  delivered: "sent",
  read: "sent",
  simulated: "simulated",
  pending: "pending",
  queued: "pending",
  review_required: "pending",
  reconciliation_required: "pending",
  failed: "not_delivered",
  blocked: "not_delivered",
  skipped: "not_delivered",
  expired: "not_delivered",
  suppressed_by_consent: "not_delivered",
}

export function borrowerNotificationStatus(status: string): BorrowerNotificationStatus {
  // An unknown state claims nothing either way.
  return BORROWER_NOTIFICATION_STATUS[status] ?? "pending"
}

// Legs WE chose not to send: the lender has the channel off, or another
// reminder already sent a WhatsApp at this offset
// (overdueWhatsAppSuppressionReason, lib/collections/reminders.ts). Nothing
// failed to reach the borrower, so nothing is shown to them as "not delivered".
const WHATSAPP_CHANNEL_OFF_REASON = "WhatsApp channel is off"
const DUPLICATE_WHATSAPP_SUPPRESSED = / reminder stage already sends a WhatsApp at this offset$/

/**
 * A `blocked` row that is an internal operating fact rather than something that
 * happened to the borrower. Matched on the exact reason: `blocked` also carries
 * consent suppression and "No WhatsApp on file", which stay visible. A row with
 * no reason is kept (the comparison fails towards showing it).
 */
export function hiddenFromBorrower(row: { status: string; error: string | null }): boolean {
  if (row.status !== "blocked" || !row.error) return false
  return row.error === SMS_CHANNEL_OFF_REASON
    || row.error === WHATSAPP_CHANNEL_OFF_REASON
    || DUPLICATE_WHATSAPP_SUPPRESSED.test(row.error)
}
