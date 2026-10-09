import { escapeHtml, formatDateTime } from "@/lib/utils"
import { sanitiseOutreachVar } from "@/lib/crm/lead-outreach-templates"

// Pure: no prisma, no network. The cron (app/api/cron/lead-task-reminders)
// does the querying and dispatching; everything decidable without a database
// lives here so it can be tested directly.
//
// ── These messages go to STAFF, not to leads ──────────────────────────────
// They use deliberately STAFF-classified Contacts and TRANSACTIONAL templates
// in the authoritative Message pipeline. This preserves provider evidence and
// idempotency without confusing the recipient with a customer/lead Contact or
// claiming a customer consent basis for an internal operational reminder.

/** How far past its due time a task may be and still earn a reminder. */
export const REMINDER_LOOKBACK_DAYS = 7

/** Longest a task title may be inside a reminder body. */
const MAX_TITLE_IN_BODY = 120

export type ReminderChannel = "WHATSAPP" | "EMAIL" | "NONE"

/**
 * Which channel a staff reminder goes out on.
 *
 * Phone → WhatsApp, otherwise email. The fallback is not decoration: 0 of the
 * 5 active staff on staging have `User.phone` set (all have emails), so a
 * WhatsApp-only reminder would ship inert and every reminder would silently go
 * nowhere. The stale-leads-alert cron already emails agents — same precedent.
 *
 * `waEnabled` is the tenant's CommsSettings.whatsappEnabled. When WhatsApp is
 * off tenant-wide we fall through to email rather than to NONE: the point is
 * that the reminder arrives, and the channel is an implementation detail.
 */
export function reminderChannelFor(a: {
  waEnabled: boolean
  phone?: string | null
  email?: string | null
}): ReminderChannel {
  if (a.waEnabled && a.phone && a.phone.trim()) return "WHATSAPP"
  if (a.email && a.email.trim()) return "EMAIL"
  return "NONE"
}

/**
 * Dedupe key for one reminder about one task.
 *
 * Paired with `windowStart = task.dueAt`, the NotificationThrottle unique
 * constraint (tenantId, channelKey, windowStart) makes "remind exactly once
 * per due time" an atomic insert rather than a check-then-act. Rescheduling a
 * task to a new dueAt yields a new windowStart and therefore a new reminder,
 * which is the behaviour you want. Without this the cron is not wireable at
 * all — 12 crons in this system are currently unwired precisely because of
 * double-send risk.
 */
export function taskReminderThrottleKey(taskId: string): string {
  return `lead-task-reminder:${taskId}`
}

/**
 * Identity of one claim: the key AND the due time it was claimed for.
 *
 * Both halves matter. The throttle row is unique on
 * (tenantId, channelKey, windowStart), so a task rescheduled to a new dueAt is
 * a DIFFERENT claim — comparing on channelKey alone would treat the old
 * claim as covering the new due time and silently drop that reminder.
 */
export function taskReminderClaimId(taskId: string, dueAt: Date): string {
  return claimId(taskReminderThrottleKey(taskId), dueAt)
}

/**
 * The same identity, derived from a stored NotificationThrottle row.
 *
 * Both sides of the comparison go through `claimId`, so the format cannot
 * drift between the key we look for and the key we build from the DB — if it
 * did, every lookup would miss and every task would remind on every run.
 */
export function throttleRowClaimId(row: { channelKey: string; windowStart: Date }): string {
  return claimId(row.channelKey, row.windowStart)
}

function claimId(channelKey: string, windowStart: Date): string {
  return `${channelKey}@${windowStart.getTime()}`
}

/**
 * Which of these due tasks still need reminding.
 *
 * Pure, and separated from the query on purpose: the cron pages through
 * candidates precisely BECAUSE already-claimed tasks must not consume the
 * page budget. A page-sized `take` with no exclusion re-selects the same
 * already-reminded tasks every run, and any task beyond the cap is then never
 * reminded at all — not late, never. This predicate is what the pager uses to
 * tell "already done" from "still owed", so it is worth testing directly.
 */
export function unclaimedTasks<T extends { id: string; dueAt: Date | null }>(
  candidates: T[],
  claimIds: ReadonlySet<string>
): T[] {
  return candidates.filter(
    (t) => t.dueAt !== null && !claimIds.has(taskReminderClaimId(t.id, t.dueAt))
  )
}

type ReminderFacts = {
  taskTitle: string
  leadName: string
  dueAt: Date
}

/**
 * Values are flattened + capped before they enter any body.
 *
 * `leadName` is built from `Lead.firstName`/`lastName`, which are public-form
 * input: app/api/website/apply accepts them on a bare truthiness check — no
 * length cap, no charset filter — from anyone, with any phone number. The
 * reminder body IS the sink (no markup needed), so an unsanitised lead name
 * lets a member of the public author text that arrives on a staff member's
 * WhatsApp from the lender's own verified identity: smishing aimed at staff
 * rather than at customers. The task title is staff-entered and already capped
 * by validateNewLeadTask, but it is flattened on the same principle — one
 * unsanitised var is all it takes.
 */
function safeFacts(f: ReminderFacts) {
  return {
    title: sanitiseOutreachVar(f.taskTitle, MAX_TITLE_IN_BODY),
    lead: sanitiseOutreachVar(f.leadName),
    due: formatDateTime(f.dueAt),
  }
}

/** The in-app bell item. Rendered as a React text child — never as HTML. */
export function buildTaskReminderBell(f: ReminderFacts): { title: string; body: string } {
  const s = safeFacts(f)
  return {
    title: `Task due: ${s.title}`,
    body: `${s.lead} — due ${s.due}`,
  }
}

/**
 * The WhatsApp body.
 *
 * Deliberately does not invite a reply. Inbound WhatsApp is routed by phone
 * number to a Contact (app/api/webhooks/whatsapp/route.ts) — a staff reply
 * would land in the customer inbox path, not on the task. "Open the task in
 * the CRM" is the only instruction this system can actually honour.
 */
export function buildTaskReminderWhatsApp(f: ReminderFacts & { url: string }): string {
  const s = safeFacts(f)
  return (
    `CRM reminder — a task is due.\n` +
    `Task: ${s.title}\n` +
    `Lead: ${s.lead}\n` +
    `Due: ${s.due}\n` +
    `Open it here: ${f.url}`
  )
}

/**
 * The email body. Every interpolated value is HTML-escaped: unlike the
 * WhatsApp string this really is an HTML context, so flattening alone would
 * still let a lead name of `<a href=...>` inject a link into mail that staff
 * receive from their own system.
 */
export function buildTaskReminderEmail(
  f: ReminderFacts & { url: string; assigneeName: string }
): { subject: string; html: string } {
  const s = safeFacts(f)
  const name = sanitiseOutreachVar(f.assigneeName)
  return {
    subject: `Task due: ${s.title}`,
    html: `<!DOCTYPE html>
<html>
<body style="font-family:sans-serif;color:#111827;max-width:600px;margin:0 auto;padding:24px">
  <p style="font-size:15px">Hi ${escapeHtml(name)},</p>
  <p style="font-size:15px">A CRM task assigned to you is due.</p>
  <table style="width:100%;border-collapse:collapse;margin:16px 0">
    <tr>
      <td style="padding:8px 12px;border-bottom:1px solid #f0f0f0;color:#6B7280;width:80px">Task</td>
      <td style="padding:8px 12px;border-bottom:1px solid #f0f0f0;font-weight:600">${escapeHtml(s.title)}</td>
    </tr>
    <tr>
      <td style="padding:8px 12px;border-bottom:1px solid #f0f0f0;color:#6B7280">Lead</td>
      <td style="padding:8px 12px;border-bottom:1px solid #f0f0f0">${escapeHtml(s.lead)}</td>
    </tr>
    <tr>
      <td style="padding:8px 12px;border-bottom:1px solid #f0f0f0;color:#6B7280">Due</td>
      <td style="padding:8px 12px;border-bottom:1px solid #f0f0f0;color:#EF4444;font-weight:600">${escapeHtml(s.due)}</td>
    </tr>
  </table>
  <p style="font-size:15px"><a href="${escapeHtml(f.url)}" style="color:#4338CA;font-weight:600">Open the task in the CRM</a></p>
</body>
</html>`,
  }
}
