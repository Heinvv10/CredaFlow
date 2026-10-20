/**
 * Which messages are DUNNING: a reminder or overdue notice sent to press for
 * payment. `sendMessage` stores the answer on the row (`Message.dunning`) when
 * it creates it, and the retry sweep reads that flag, never a template key.
 *
 * It matters because a client hold (lib/collections/client-holds.ts) stops
 * dunning only. A borrower under debt review is still owed their statements,
 * receipts, disbursement notices and inbox replies, and a transactional message
 * (an OTP, an application decline) is never held.
 *
 * Every dunning send site passes one of these as `category`; a NEW reminder
 * category must be added here or its retries will not be held.
 */
export const DUNNING_MESSAGE_CATEGORIES: ReadonlySet<string> = new Set([
  // lib/collections/reminders.ts (consumer and entity legs)
  "collections",
  // app/api/loans/[id]/collections-stage/route.ts
  "collections_stage_reminder",
  // app/api/collections/[loanId]/reminder/route.ts
  "manual_reminder",
  // app/api/notifications/payment, entity reminders
  "payment_due_reminder",
  // lib/notifications.ts passes the event name as the category
  "loan_overdue",
  "loan_overdue_1d",
  "loan_overdue_7d",
])

export function isDunningCategory(category: string | undefined | null): boolean {
  return category != null && DUNNING_MESSAGE_CATEGORIES.has(category)
}
