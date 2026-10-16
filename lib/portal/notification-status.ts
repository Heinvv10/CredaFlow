import { SMS_CHANNEL_OFF_REASON } from "@/lib/messaging/sms-channel"

/**
 * What a borrower is told about a message we sent them. NotificationLog.status
 * is an internal delivery/reconciliation state ("review_required" means the
 * provider accepted it but its receipt is not yet linked; "blocked" can mean a
 * consent suppression). None of that is the borrower's business, and showing
 * it made a working account look broken (Fair Score audit 2026-10-16). The row
 * itself is unchanged for staff and the audit trail.
 */
export type BorrowerNotificationStatus = "sent" | "not_delivered" | "pending" | "simulated"

const SENT = new Set(["sent", "delivered", "read", "review_required"])
const NOT_DELIVERED = new Set(["failed", "skipped", "blocked"])

export function borrowerNotificationStatus(status: string): BorrowerNotificationStatus {
  if (SENT.has(status)) return "sent"
  if (NOT_DELIVERED.has(status)) return "not_delivered"
  // Only a demo transport writes "simulated"; it is not a real message, so it
  // must not claim to have been sent.
  if (status === "simulated") return "simulated"
  return "pending"
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
