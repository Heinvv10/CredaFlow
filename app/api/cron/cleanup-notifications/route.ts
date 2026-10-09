import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { verifyCronSecret } from "@/lib/cron-auth"
import { getTenantFromRequest } from "@/lib/tenant"
import { AuditAction } from "@/lib/audit"
import {
  notificationPurgeCutoff,
  throttlePurgeCutoff,
  NOTIFICATION_RETENTION_DAYS,
  THROTTLE_RETENTION_DAYS,
  retentionPeriodsAreCoherent,
} from "@/lib/notifications/retention"

/**
 * Cleanup Cron — bounds the two tables the lead-task reminder writes to.
 *
 * Runs nightly via a host systemd timer, wired as part of the same delivery as
 * this route. That is not a formality: an unwired purge is a no-op wearing a
 * purge's name, and NotificationThrottle grows forever — the stated reason this
 * exists. (cleanup-disclosures is the pattern for CHOOSING a retention period
 * from the data's purpose and arguing it in code — lib/notifications/retention.ts
 * does the same. It is NOT a precedent for scheduling: it is itself unwired.)
 *
 *  - `Notification` — POPIA s.14(1): a bell item's purpose (prompt the
 *    assignee) expires; the row should not outlive it.
 *  - `NotificationThrottle` — a dedupe ledger with no purge until now. Every
 *    reminder and every portal identity notice adds a row forever.
 *
 * Auth: x-cron-secret header must match CRON_SECRET (lib/cron-auth.ts); the
 * /api/cron/ prefix is allow-listed in lib/public-routes.ts so the session gate
 * does not 401 it first.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const denied = verifyCronSecret(req)
  if (denied) return denied

  // Fail loudly rather than double-send. If someone raises the reminder
  // lookback past the throttle retention, purging a claim whose task is still
  // selectable makes the next sweep remind that person a second time. Refusing
  // to run costs disk; running costs staff trust.
  if (!retentionPeriodsAreCoherent()) {
    console.error(
      `[cron/cleanup-notifications] REFUSING: THROTTLE_RETENTION_DAYS (${THROTTLE_RETENTION_DAYS}) must exceed the reminder lookback — purging live claims would re-send reminders`
    )
    return NextResponse.json({ error: "Retention periods are incoherent" }, { status: 500 })
  }

  const tenant = await getTenantFromRequest(req)
  if (!tenant) return NextResponse.json({ error: "Tenant not found" }, { status: 400 })

  const now = new Date()

  // `Notification` IS in TENANT_SCOPED_MODELS and a cron has no ALS frame, so
  // the explicit tenantId is what stops the rewriter throwing missing-context.
  const notifications = await prisma.notification.deleteMany({
    where: { tenantId: tenant.id, createdAt: { lt: notificationPurgeCutoff(now.getTime()) } },
  })

  // Filtered on `windowStart`, not `createdAt`: windowStart is the window the
  // claim covers, and it is what the reminder cron's selection is expressed in
  // — so this predicate and retentionPeriodsAreCoherent() check the same thing.
  // See throttlePurgeCutoff for why createdAt is only accidentally safe.
  //
  // `NotificationThrottle` is NOT a scoped model — this tenantId filter is
  // manual and load-bearing, or a nightly run would reap another tenant's
  // claims and re-open their sends.
  const throttles = await prisma.notificationThrottle.deleteMany({
    where: { tenantId: tenant.id, windowStart: { lt: throttlePurgeCutoff(now.getTime()) } },
  })

  // Record the erasure. Deleting personal data is itself a processing
  // operation — POPIA s.17 documentation, and "prove you deleted it" is what a
  // DSAR or an auditor actually asks. A console line is not evidence, and this
  // is the first cron in the codebase that deletes ROWS rather than files
  // (cleanup-disclosures removes draft PDFs), so there is no precedent that
  // says logging is enough. `userId: null` = system actor, matching the
  // reminder producer: the cron is the actor, not any staff member.
  //
  // Only written when something was actually erased — a nightly no-op row adds
  // noise to the trail and nothing to the evidence. Best-effort: the rows are
  // already gone, so throwing here would only turn a successful purge into a
  // failed cron and re-run it against nothing.
  if (notifications.count > 0 || throttles.count > 0) {
    await prisma.auditLog
      .create({
        data: {
          tenantId: tenant.id,
          userId: null,
          userEmail: null,
          action: AuditAction.NOTIFICATION_DATA_PURGED,
          entity: "Notification",
          newValue: {
            notificationsPurged: notifications.count,
            throttlesPurged: throttles.count,
            notificationRetentionDays: NOTIFICATION_RETENTION_DAYS,
            throttleRetentionDays: THROTTLE_RETENTION_DAYS,
            notificationCutoff: notificationPurgeCutoff(now.getTime()).toISOString(),
            throttleCutoff: throttlePurgeCutoff(now.getTime()).toISOString(),
          },
        },
      })
      .catch((err: unknown) => {
        console.error("[cron/cleanup-notifications] Erasure audit row failed:", err)
      })
  }

  console.log(
    `[cron/cleanup-notifications] Purged ${notifications.count} notification(s) older than ${NOTIFICATION_RETENTION_DAYS}d, ${throttles.count} throttle claim(s) older than ${THROTTLE_RETENTION_DAYS}d`
  )

  return NextResponse.json({
    ok: true,
    notificationsPurged: notifications.count,
    throttlesPurged: throttles.count,
    notificationRetentionDays: NOTIFICATION_RETENTION_DAYS,
    throttleRetentionDays: THROTTLE_RETENTION_DAYS,
    runAt: now.toISOString(),
  })
}
