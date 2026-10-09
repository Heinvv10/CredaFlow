import { REMINDER_LOOKBACK_DAYS } from "@/lib/notifications/task-reminder"

// Retention periods for the two tables the reminder feature writes to, and the
// reasoning that picks them. Pure — no prisma — so the arithmetic and the
// relationship between the two periods are directly testable.
//
// ── Why periods are chosen here rather than deferred to legal ─────────────
// POPIA s.14(1) derives a retention period from the PURPOSE of the processing,
// not from a lawyer's preference, so "we cannot pick one" is not an answer —
// and this repo already makes the same call unaided (app/api/cron/
// cleanup-disclosures purges FAIS draft PDFs at 7 days, with its reasoning in
// its own docstring). Each period below is tied to the purpose it serves and
// stated so a later reader can argue with it. They are deliberately named
// constants: changing one is a one-line, reviewable decision.

const DAY_MS = 86_400_000

/**
 * How long a bell item is kept.
 *
 * PURPOSE: prompt a staff member to action a task that has come due. That
 * purpose is exhausted quickly — the reminder sweep itself only looks back
 * REMINDER_LOOKBACK_DAYS (7), and any task still open past that is surfaced by
 * the work queue, not by the bell. 90 days is therefore already generous: it
 * covers a staff member returning from extended leave and any internal "was I
 * ever told?" dispute, while bounding how long a copy of a lead's name sits in
 * a derived table.
 *
 * NOT tied to the task's own lifecycle ("N days after it reaches COMPLETED"),
 * which would be the sharper rule: `Notification.entityId` holds the LEAD id,
 * not the task id, so there is no task to join to. Changing that is a schema
 * decision, not a retention one.
 *
 * Proportionality, stated plainly: `Notification.body` holds a lead's name
 * truncated to 40 chars plus a date — a derived duplicate of personal data that
 * `Lead`, `CrmActivity` and `AuditLog` retain indefinitely anyway. This purge
 * bounds the copy; it does not make the system POPIA-complete, and nobody
 * should read it as doing so.
 */
export const NOTIFICATION_RETENTION_DAYS = 90

/**
 * How long a NotificationThrottle claim is kept.
 *
 * PURPOSE: answer "have we already sent this?" — a dedupe ledger, not a record
 * of anything. A row may be deleted once its window can never be selected
 * again; keeping it beyond that is pure growth.
 *
 * ⚠️ This MUST stay strictly greater than REMINDER_LOOKBACK_DAYS. A lead-task
 * claim uses `windowStart = task.dueAt`, and the cron re-selects any task with
 * `dueAt >= now - REMINDER_LOOKBACK_DAYS`. Purge a claim while its task is
 * still inside that window and the next sweep sees an unclaimed due task and
 * reminds the assignee a SECOND time. Deleting too eagerly causes a duplicate
 * send; deleting too late costs only disk. Hence 30 — a >4x margin over the
 * 7-day lookback. `retentionPeriodsAreCoherent()` pins the relationship so the
 * two constants cannot drift apart silently.
 *
 * The other producer (portal-identity-notice, app/api/website/apply) uses fixed
 * 6h buckets, so 30 days is a ~120x margin there.
 */
export const THROTTLE_RETENTION_DAYS = 30

/**
 * The invariant the throttle period depends on: raising REMINDER_LOOKBACK_DAYS
 * past THROTTLE_RETENTION_DAYS would silently start double-sending reminders,
 * and nothing else would notice.
 *
 * Takes the periods as ARGUMENTS (defaulting to the configured pair) rather
 * than reading the module constants directly. That is not ceremony: a
 * no-argument predicate can only ever be asserted `toBe(true)`, which passes
 * just as happily if the body is replaced by `return true` — the guard would
 * be gone and every test would still be green. With inputs, a test can supply
 * an incoherent pair and demand `false`, which pins the comparison itself.
 */
export function retentionPeriodsAreCoherent(
  throttleDays: number = THROTTLE_RETENTION_DAYS,
  reminderLookbackDays: number = REMINDER_LOOKBACK_DAYS
): boolean {
  return throttleDays > reminderLookbackDays
}

/** Bell items created before this instant are past their purpose. */
export function notificationPurgeCutoff(now: number = Date.now()): Date {
  return new Date(now - NOTIFICATION_RETENTION_DAYS * DAY_MS)
}

/**
 * Claims whose WINDOW starts before this instant can no longer suppress
 * anything.
 *
 * Compared against `windowStart`, NOT `createdAt` — that choice is the whole
 * safety argument, not a detail. The invariant is about the window a claim
 * covers: a lead-task claim sets `windowStart = task.dueAt`, and the reminder
 * cron re-selects any task with `dueAt >= now - REMINDER_LOOKBACK_DAYS`. So
 * purging `windowStart < now - THROTTLE_RETENTION_DAYS` cannot touch a claim
 * whose task is still selectable for exactly the reason
 * retentionPeriodsAreCoherent() checks: 30 > 7. The query and the guard become
 * the same statement.
 *
 * `createdAt` would also be safe TODAY — every current producer happens to set
 * `windowStart <= createdAt` (the reminder only claims once `dueAt <= now`; the
 * apply route floors 6h buckets into the past), leaving a ~23-day margin. But
 * that is an accident of today's producers, not a property anything enforces,
 * and it is invisible from here. Add a plausible "remind N days BEFORE due"
 * feature and `windowStart = createdAt + N`: the claim stays live until
 * `createdAt + N + 7d` while a createdAt purge still fires at `createdAt + 30d`,
 * so for N > 23 a LIVE claim is deleted and the assignee is reminded twice —
 * with the coherence guard returning true throughout, because it never sees
 * `windowStart`. Filtering on the column the reasoning is about deletes that
 * whole class of bug.
 *
 * Cost: `@@index([createdAt])` does not serve this predicate, and `windowStart`
 * is the third column of `@@unique([tenantId, channelKey, windowStart])`, so
 * this is a tenant-scoped scan rather than a range seek. Accepted deliberately:
 * the table stays small precisely because this purge runs, it runs nightly, and
 * paying a scan to keep the guard honest is the right trade.
 */
export function throttlePurgeCutoff(now: number = Date.now()): Date {
  return new Date(now - THROTTLE_RETENTION_DAYS * DAY_MS)
}
