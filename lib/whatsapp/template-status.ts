import { prisma } from "@/lib/prisma"

/**
 * Meta's `message_template_status_update` webhook field.
 *
 * This is the counterpart to `/api/cron/poll-wa-templates`, not a duplicate of
 * it. The poll re-checks rows whose `providerStatus` is `PENDING`, so it can
 * only ever move a template FORWARD out of PENDING — the later
 * `APPROVED -> PAUSED` and `APPROVED -> DISABLED` transitions are invisible to
 * it by construction. Left to the poll alone, a template Meta had paused would
 * keep reading `APPROVED` locally, `lib/whatsapp-cloud.ts` would keep choosing
 * template mode, and every send would fail at Meta with no local signal.
 *
 * Keep both: the webhook is real-time and costs no Graph call, but it is only
 * as reliable as the subscription and the delivery. The poll is the belt.
 */
export type WabaTemplateStatus = {
  name: string
  status: string
  language: string | null
}

const FIELD = "message_template_status_update"

export function parseWabaTemplateStatuses(payload: unknown): WabaTemplateStatus[] {
  if (typeof payload !== "object" || payload === null) return []
  const p = payload as Record<string, unknown>
  const entries = Array.isArray(p.entry) ? p.entry : []
  const out: WabaTemplateStatus[] = []
  for (const e of entries) {
    if (typeof e !== "object" || e === null) continue
    const changes = Array.isArray((e as Record<string, unknown>).changes)
      ? ((e as Record<string, unknown>).changes as unknown[])
      : []
    for (const c of changes) {
      if (typeof c !== "object" || c === null) continue
      const cr = c as Record<string, unknown>
      // Meta sends several template-related fields on the same subscription
      // (quality updates, category updates). Only the status one carries an
      // approval transition.
      if (cr.field !== FIELD) continue
      const value = cr.value as Record<string, unknown> | undefined
      if (typeof value !== "object" || value === null) continue
      const name = value.message_template_name
      const status = value.event
      if (typeof name !== "string" || typeof status !== "string") continue
      const language = typeof value.message_template_language === "string" ? value.message_template_language : null
      out.push({ name, status, language })
    }
  }
  return out
}

/**
 * Meta's `event` vocabulary is wider than the four obvious values — it also
 * emits REINSTATED, IN_APPEAL, PENDING_DELETION, FLAGGED, ARCHIVED and more.
 *
 * Writing an unrecognised one verbatim creates a PERMANENT stuck state:
 * `lib/whatsapp-cloud.ts` gates on `providerStatus === "APPROVED"` so the
 * template becomes unsendable, and `/api/cron/poll-wa-templates` only
 * re-examines rows whose status is `PENDING` — so no code path could ever
 * reconcile it. Anything unknown is therefore parked at PENDING, which is the
 * one value the poll can still act on. This mirrors `mapWabaStatus` in
 * ./apply-statuses.ts, which likewise refuses to persist a value it does not
 * recognise.
 */
export function mapTemplateEvent(event: string): string {
  switch (event) {
    case "APPROVED":
    case "REJECTED":
    case "PAUSED":
    case "DISABLED":
      return event
    // An appeal succeeded — the template is sendable again. Without this it
    // would read REINSTATED forever and never send.
    case "REINSTATED":
      return "APPROVED"
    default:
      return "PENDING"
  }
}

/**
 * Mirrors the transitions onto MessageTemplate.providerStatus. Returns the
 * number of rows written.
 *
 * `updateMany` rather than `update`: the template name is unique per WABA at
 * Meta but is not a unique key here, and a name this tenant does not own must
 * be a no-op rather than a throw — Meta will happily deliver an update for a
 * template created outside this app.
 *
 * Scoped by language when Meta supplies one: at Meta a template is keyed by
 * name + language, so `en` can be APPROVED while `af` is REJECTED. Without the
 * filter the English verdict lands on the Afrikaans row too.
 */
export async function applyWabaTemplateStatuses(
  tenantId: string,
  statuses: WabaTemplateStatus[],
): Promise<number> {
  let written = 0
  for (const s of statuses) {
    const res = await prisma.messageTemplate.updateMany({
      where: {
        tenantId,
        wabaTemplateName: s.name,
        ...(s.language ? { language: s.language } : {}),
      },
      data: { providerStatus: mapTemplateEvent(s.status) },
    })
    written += res.count
  }
  return written
}
