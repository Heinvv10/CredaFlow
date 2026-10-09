import { NextRequest, NextResponse } from "next/server"
import { Prisma } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { getTenantFromRequest } from "@/lib/tenant"
import { verifyCronSecret } from "@/lib/cron-auth"
import { isWaEnabled } from "@/lib/whatsapp"
import { getCommsSettings } from "@/lib/inbox/settings"
import { createNotification } from "@/lib/notifications/bell"
import { sendStaffTaskReminder } from "@/lib/messaging/staff-task-reminder"
import { runWithTenant } from "@/lib/tenant-scope"
import { OPEN_TASK_STATUSES, LEAD_ENTITY_TYPE } from "@/lib/crm/lead-tasks"
import { requireAppBaseUrl } from "@/lib/config/deployment-urls"
import {
  REMINDER_LOOKBACK_DAYS,
  reminderChannelFor,
  taskReminderThrottleKey,
  throttleRowClaimId,
  unclaimedTasks,
  buildTaskReminderBell,
  buildTaskReminderWhatsApp,
  buildTaskReminderEmail,
} from "@/lib/notifications/task-reminder"

// Reminds the assignee of a lead task that has come due: an in-app bell item
// plus one push (WhatsApp if they have a phone, else email).
//
// ── Delivery guarantee ────────────────────────────────────────────────────
// The BELL is exactly-once per (task, dueAt): the throttle claim and the bell
// row are written in ONE transaction, so a crash between them rolls both back
// and the next run retries. The PUSH uses a deterministic Message reservation
// for the same occurrence, so a repeated dispatch request cannot create a
// second outbound Message. A transient WhatsApp rejection may use the generic
// retry worker; an ambiguous outcome is held for reconciliation, never replayed.
// Do not "improve" this by claiming before the transaction — an orphaned
// claim silences the task permanently (nothing purges NotificationThrottle).
//
// ── No ALS frame ──────────────────────────────────────────────────────────
// A cron starts outside withTenantContext. The bell transaction passes an
// explicit tenantId; the Message pipeline is wrapped in runWithTenant because
// its internal contact/consent reads intentionally rely on the ALS frame.
// `AgentTask`, `Lead`, `User` and `NotificationThrottle` are NOT scoped models,
// so their tenantId filters below are manual and load-bearing.

const DAY_MS = 86_400_000
/** Most reminders one run will send. Bounds the wall time of a loop whose
 *  every iteration makes a network call, so the request cannot outlive its
 *  own timer. */
const SEND_CAP = 100
const PAGE_SIZE = 200
/** Hard bound on paging, so a pathological backlog cannot spin forever.
 *  MAX_PAGES × PAGE_SIZE = 4000 candidate rows scanned per run: beyond that the
 *  tail of the window is not reached until earlier tasks age past the lookback.
 *  The bound is stated here so it is not discovered by surprise; the
 *  truncation warning fires when it bites. */
const MAX_PAGES = 20

/** Thrown inside the claim transaction to roll it back without logging an
 *  error — the task stopped being remindable while we were working. */
class TaskNoLongerDue extends Error {}

type DueTask = {
  id: string
  title: string
  dueAt: Date | null
  assigneeId: string | null
  entityId: string | null
}

/**
 * Collect due tasks that have NOT already been reminded.
 *
 * Pages deliberately. A single `take` with no exclusion of claimed tasks
 * re-selects the same already-reminded rows on every run; once the cap is
 * full of them, any further due task is never reminded at all. Filtering
 * claimed rows out per page and continuing means an already-reminded backlog
 * costs reads, not reminders.
 */
async function collectRemindable(
  tenantId: string,
  now: Date,
  floor: Date
): Promise<{ work: DueTask[]; scanned: number; truncated: boolean }> {
  const work: DueTask[] = []
  let cursor: string | undefined
  let scanned = 0

  for (let page = 0; page < MAX_PAGES; page++) {
    const batch: DueTask[] = await prisma.agentTask.findMany({
      where: {
        tenantId,
        status: { in: [...OPEN_TASK_STATUSES] },
        entityType: LEAD_ENTITY_TYPE,
        dueAt: { lte: now, gte: floor },
        assigneeId: { not: null },
      },
      select: { id: true, title: true, dueAt: true, assigneeId: true, entityId: true },
      // Stable, unique order so the cursor cannot skip or repeat a row.
      orderBy: { id: "asc" },
      take: PAGE_SIZE,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    })
    if (batch.length === 0) break
    cursor = batch[batch.length - 1].id
    scanned += batch.length

    const claims = await prisma.notificationThrottle.findMany({
      where: {
        tenantId,
        channelKey: { in: batch.map((t) => taskReminderThrottleKey(t.id)) },
      },
      select: { channelKey: true, windowStart: true },
    })
    const claimIds = new Set(claims.map(throttleRowClaimId))

    for (const task of unclaimedTasks(batch, claimIds)) {
      work.push(task)
      if (work.length >= SEND_CAP) return { work, scanned, truncated: true }
    }

    if (batch.length < PAGE_SIZE) break
    if (page === MAX_PAGES - 1) return { work, scanned, truncated: true }
  }

  return { work, scanned, truncated: false }
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const denied = verifyCronSecret(req)
  if (denied) return denied

  const tenant = await getTenantFromRequest(req)
  if (!tenant) return NextResponse.json({ error: "Tenant not found" }, { status: 400 })

  const now = new Date()
  // Only tasks that came due within the lookback window. Without a floor, a
  // cron outage (or the first run after wiring) would fire every historical
  // due task at once. Anything older than this is not a reminder any more —
  // it is backlog, and the work queue is where that belongs.
  const floor = new Date(now.getTime() - REMINDER_LOOKBACK_DAYS * DAY_MS)

  const { work, scanned, truncated } = await collectRemindable(tenant.id, now, floor)

  if (truncated) {
    // Never let a bounded sweep look like a complete one.
    console.warn(
      `[cron/lead-task-reminders] Hit a cap (scanned ${scanned}, queued ${work.length}) — remaining due tasks wait for the next run`
    )
  }
  if (work.length === 0) {
    console.log(`[cron/lead-task-reminders] Nothing to remind (scanned ${scanned})`)
    // Same shape as the main return — one endpoint must not report two
    // different objects, or a caller parsing `unrecorded` gets undefined on
    // the quiet path and cannot tell "none" from "not reported".
    return NextResponse.json({
      ok: true,
      reminded: 0, pushed: 0, simulated: 0, pending: 0,
      reconciliationRequired: 0, failed: 0, unrecorded: 0, claimFailed: 0,
      queued: 0, scanned, truncated,
    })
  }

  const settings = await getCommsSettings(tenant.id)
  const waEnabled = settings.whatsappEnabled && isWaEnabled()

  // `User` is not tenant-scoped by the rewriter — filter manually, and take
  // only active staff: a deactivated account must not receive a push.
  const assignees = await prisma.user.findMany({
    where: {
      id: { in: [...new Set(work.map((t) => t.assigneeId!))] },
      tenantId: tenant.id,
      active: true,
    },
    select: { id: true, name: true, email: true, phone: true },
  })
  const byId = new Map(assignees.map((u) => [u.id, u]))

  const leads = await prisma.lead.findMany({
    where: {
      id: { in: [...new Set(work.map((t) => t.entityId).filter((id): id is string => !!id))] },
      tenantId: tenant.id,
    },
    select: { id: true, firstName: true, lastName: true },
  })
  const leadById = new Map(leads.map((l) => [l.id, l]))

  const base = requireAppBaseUrl()
  let reminded = 0
  let pushed = 0
  let simulated = 0
  let pending = 0
  let reconciliationRequired = 0
  let failed = 0
  /** A provider outcome was known, but the accountability record did not land.
   *  Count it separately so neither a dispatch nor a simulation can look clean
   *  after a DB blip. */
  let unrecorded = 0
  /** The claim+bell transaction itself failed (not TaskNoLongerDue, not a
   *  P2002 race with another run) — the task is rolled back to unclaimed and
   *  will retry next run, but a write path that keeps failing must surface,
   *  not just log and move on. */
  let claimFailed = 0

  for (const task of work) {
    const dueAt = task.dueAt
    if (!dueAt) continue

    const user = byId.get(task.assigneeId!)
    if (!user) {
      // Assignee deactivated or in another tenant. Skipped without a claim, so
      // reassigning the task makes it remindable again — but say so, or the
      // task simply goes quiet.
      console.warn(`[cron/lead-task-reminders] Task ${task.id} skipped — assignee ${task.assigneeId} is not active staff in this tenant`)
      continue
    }
    const lead = task.entityId ? leadById.get(task.entityId) : null
    if (!lead) {
      // entityType/entityId is a polymorphic pair with no FK, so it can outlive
      // the lead it names.
      console.warn(`[cron/lead-task-reminders] Task ${task.id} skipped — lead ${task.entityId} not found in this tenant`)
      continue
    }

    const facts = {
      taskTitle: task.title,
      leadName: `${lead.firstName} ${lead.lastName}`.trim(),
      dueAt,
    }
    const bell = buildTaskReminderBell(facts)
    const channelKey = taskReminderThrottleKey(task.id)

    // Claim + bell atomically. The unique constraint on
    // (tenantId, channelKey, windowStart) makes the claim an atomic insert
    // rather than a check-then-act, and windowStart is the task's own dueAt,
    // so the pair reminds exactly once per due time. Rescheduling to a new
    // dueAt is a new claim and earns a new reminder, which is the intent.
    try {
      await prisma.$transaction(async (tx) => {
        // Re-read inside the transaction: `work` was collected before a loop of
        // network sends, so a task completed in the meantime would otherwise
        // still nag. Matching on dueAt too catches a reschedule mid-run.
        const fresh = await tx.agentTask.findFirst({
          where: {
            id: task.id,
            tenantId: tenant.id,
            status: { in: [...OPEN_TASK_STATUSES] },
            dueAt,
          },
          select: { id: true },
        })
        if (!fresh) throw new TaskNoLongerDue()

        await tx.notificationThrottle.create({
          data: { tenantId: tenant.id, channelKey, windowStart: dueAt },
        })
        await createNotification(
          {
            tenantId: tenant.id,
            userId: user.id,
            type: "TASK_DUE",
            title: bell.title,
            body: bell.body,
            entityType: LEAD_ENTITY_TYPE,
            entityId: lead.id,
          },
          tx.notification
        )
      })
      reminded++
    } catch (err) {
      if (err instanceof TaskNoLongerDue) continue
      // P2002 = a concurrent run claimed this task+dueAt first. The pre-filter
      // in collectRemindable skips most of these; this is the race backstop.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") continue
      // Rolled back — no claim, no bell — so the next run retries this task.
      console.error(`[cron/lead-task-reminders] Claim+bell failed for ${task.id}:`, err)
      claimFailed++
      continue
    }

    // The external push has its own deterministic Message reservation. The
    // bell claim and provider dispatch are intentionally separate: a crash can
    // leave the bell as the fallback, while the occurrence key prevents a
    // later operator/recovery path from creating a duplicate external send.
    const channel = reminderChannelFor({ waEnabled, phone: user.phone, email: user.email })
    const url = `${base}/crm/leads/${lead.id}`
    if (channel === "NONE") {
      console.warn(`[cron/lead-task-reminders] No channel for user ${user.id} — bell only`)
      continue
    }

    const text = buildTaskReminderWhatsApp({ ...facts, url })
    const mail = channel === "EMAIL"
      ? buildTaskReminderEmail({ ...facts, url, assigneeName: user.name ?? "there" })
      : null
    const result = await runWithTenant(tenant.id, () => sendStaffTaskReminder({
      tenantId: tenant.id,
      taskId: task.id,
      leadId: lead.id,
      dueAt,
      recipientUserId: user.id,
      recipientName: user.name,
      recipientEmail: user.email,
      channel,
      toValue: channel === "WHATSAPP" ? user.phone! : user.email,
      subject: mail?.subject,
      text,
      html: mail?.html,
    }))
    if (!result.recorded) unrecorded++
    else if (result.outcome === "sent") pushed++
    else if (result.outcome === "simulated") simulated++
    else if (result.outcome === "pending") pending++
    else if (result.outcome === "reconciliation_required") reconciliationRequired++
    else failed++
    if (result.outcome === "failed") {
      console.error(`[cron/lead-task-reminders] ${channel} push failed for user ${user.id}: ${result.error ?? "unknown error"}`)
    }
  }

  if (unrecorded > 0) {
    console.warn(`[cron/lead-task-reminders] ${unrecorded} provider outcome(s) WITHOUT an accountability record`)
  }
  console.log(
    `[cron/lead-task-reminders] Done — ${reminded} reminded (${pushed} sent, ${simulated} simulated, ${pending} pending, ${reconciliationRequired} reconciliation, ${failed} failed) of ${work.length} queued, ${scanned} scanned${truncated ? " (capped)" : ""}`
  )
  // failed/unrecorded/reconciliationRequired/claimFailed are all rows this
  // run could not cleanly complete on its own — a provider failure, a lost
  // accountability record, an ambiguous outcome needing a human, or a claim
  // transaction that kept failing. simulated/pending are expected, understood
  // outcomes and do not count. The systemd wrapper calls this with
  // `curl -fsS`, which only fails the unit on HTTP >= 400 and never parses
  // this body, so a hardcoded 200 would hide any of these indefinitely.
  const ok = failed === 0 && unrecorded === 0 && reconciliationRequired === 0 && claimFailed === 0
  return NextResponse.json(
    {
      ok,
      reminded, pushed, simulated, pending, reconciliationRequired, failed,
      unrecorded, claimFailed, queued: work.length, scanned, truncated,
    },
    { status: ok ? 200 : 503 },
  )
}
