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

/**
 * The loan an AUTOMATED dunning message was sent about, read from its idempotency
 * key (Message has no loan column), and whether it is a NOTICE rather than a
 * reminder:
 *  - `collections:<loanId>:<reminder>:...` from the reminders cron: a reminder.
 *  - `entity-notice:<loanId>:<occurrence>:...` from an entity borrower's: a reminder,
 *    except `loan_overdue` (lib/asset-finance/entity-notifications.ts), which is the
 *    entity's 60-DPD DEFAULTED notice.
 *  - `notification:loan_overdue:<loanId>:...`, the consumer loan_overdue
 *    notification, which is also the 60-DPD DEFAULTED notice.
 * A notice must still reach a DEFAULTED loan (the escalation cron flips the loan
 * first, then sends it) and its wording is not dated, so it is not expired at the
 * end of its day. Null for anything else.
 *
 * A staff reminder (`manual-reminder:`) and a stage WhatsApp (`collections-stage:`)
 * are null on purpose: staff chose to write, and keep an arrangement or an
 * attorney-referred loan open (lib/collections/.claude.md), so the retry sweep
 * holds only the automated ones for a loan hold (lib/messaging/retry.ts).
 */
export function automatedDunningLoan(idempotencyKey: string | null | undefined): { loanId: string; notice: boolean } | null {
  const key = idempotencyKey ?? ""
  const collections = /^collections:([^:]+):/.exec(key)
  if (collections) return { loanId: collections[1], notice: false }
  const entity = /^entity-notice:([^:]+):([^:]+):/.exec(key)
  if (entity) return { loanId: entity[1], notice: entity[2].startsWith("loan_overdue") }
  const notice = /^notification:loan_overdue[a-z0-9_]*:([^:]+):/.exec(key)
  return notice ? { loanId: notice[1], notice: true } : null
}
