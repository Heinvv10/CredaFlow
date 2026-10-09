import { prisma } from "@/lib/prisma"
import { sendEmail } from "@/lib/email/service"
import type { WaBridgeSlot } from "@/lib/whatsapp-bridge-admin"

export type WaBridgeAlertSeverity = "WARNING" | "CRITICAL"

export interface WaBridgeAlertDecision {
  severity: WaBridgeAlertSeverity
  message: string
}

type PreviousSlotStatus = { slotId: string; status: string }

// Compares the previously-stored status per slot against the freshly polled
// state and decides whether an alert-worthy transition happened. Pure
// function — the cron (Task 9) does the I/O, this only decides.
export function decideWaBridgeAlert(previous: PreviousSlotStatus[], current: WaBridgeSlot[]): WaBridgeAlertDecision | null {
  const previousBySlot = new Map(previous.map((p) => [p.slotId, p.status]))
  // PAUSED is an operator parking a number, not a failure — alerting on it
  // would email every ADMIN a CRITICAL for a deliberate admin action, which
  // is how people learn to ignore these emails. A genuine outage while
  // everything is parked is still caught: the cron's allDown fallback reads
  // "is anything CONNECTED", independently of this transition diff.
  const droppedSlots = current.filter(
    (c) => previousBySlot.get(c.slotId) === "CONNECTED" && c.status !== "CONNECTED" && c.status !== "PAUSED",
  )
  if (droppedSlots.length === 0) return null

  const stillConnected = current.filter((c) => c.status === "CONNECTED")
  const droppedLabel = droppedSlots.map((s) => s.number ?? s.slotId).join(", ")

  if (stillConnected.length === 0) {
    return { severity: "CRITICAL", message: `All WhatsApp numbers are disconnected (${droppedLabel}). No outbound WhatsApp is possible.` }
  }

  const active = stillConnected.reduce((best, s) => (s.priority < best.priority ? s : best))
  return { severity: "WARNING", message: `WhatsApp number ${droppedLabel} disconnected. Traffic has failed over to ${active.number ?? active.slotId}.` }
}

function alertEmailHtml(decision: WaBridgeAlertDecision): string {
  const color = decision.severity === "CRITICAL" ? "#EF4444" : "#F59E0B"
  return `<!DOCTYPE html>
<html>
<body style="font-family:sans-serif;color:#111827;max-width:600px;margin:0 auto;padding:24px">
  <p style="font-size:15px;font-weight:600;color:${color}">${decision.severity}: WhatsApp bridge status changed</p>
  <p style="font-size:15px">${decision.message}</p>
  <p style="font-size:13px;color:#6B7280">Check Settings &rarr; WhatsApp &rarr; Bridge to review or add a number.</p>
</body>
</html>`
}

// Ops override narrowing who gets paged, as a comma-separated list of email
// addresses matched case-insensitively. Unset (the default, and what every
// other environment does) means every active ADMIN/SUPER_ADMIN, unchanged.
//
// This is a NARROWING filter over the admin query, never a replacement for
// it: an address listed here that is not an active ADMIN/SUPER_ADMIN of the
// tenant receives nothing. These alerts describe infrastructure state, and an
// env var is a weaker gate than a role check — a typo'd or stale entry must
// not become a subscription for someone who isn't staff, and must not survive
// that person being deactivated.
//
// Narrowing to nobody is already visible rather than silent: the caller logs
// WA_BRIDGE_ALERT_UNDELIVERABLE and declines to latch the alarm when zero
// recipients were reached, so the next poll retries.
function alertRecipientAllowlist(): Set<string> | null {
  const configured = process.env.WA_BRIDGE_ALERT_RECIPIENTS
  if (!configured) return null
  const addresses = configured
    .split(",")
    .map((address) => address.trim().toLowerCase())
    .filter(Boolean)
  // An entry of only whitespace or commas is a misconfiguration, not an
  // instruction to page nobody — fall back to the full admin list.
  return addresses.length > 0 ? new Set(addresses) : null
}

// User isn't a tenant-scoped model in the shared middleware sense — the
// tenantId filter here is deliberate, not redundant (see
// project_tenant_scoped_models_excludes_user_branch in memory).
export async function sendWaBridgeAlert(tenantId: string, decision: WaBridgeAlertDecision): Promise<number> {
  const recipients = await prisma.user.findMany({
    where: { tenantId, role: { in: ["ADMIN", "SUPER_ADMIN"] }, active: true },
    select: { id: true, email: true, name: true },
  })
  const allowlist = alertRecipientAllowlist()
  const addressable = recipients.filter((r) => r.email)
  const narrowed = allowlist
    ? addressable.filter((r) => allowlist.has(r.email!.toLowerCase()))
    : addressable

  // A narrowing filter that matches NOBODY is a misconfiguration, not an
  // instruction to page nobody. One mistyped character otherwise silences the
  // outage alert on a channel carrying NCA notices — the exact silent failure
  // this monitor exists to catch, and reproduced during review: 4 active
  // admins, one wrong character, zero alerts delivered, the only trace an
  // unwatched audit row.
  //
  // The fallback is to the ADMIN LIST, never to the unmatched address, so the
  // env var still cannot widen the audience beyond active ADMIN/SUPER_ADMINs.
  // It also only fires when the allowlist matched nothing — a filter that
  // matched at least one admin is a deliberate narrowing and is honoured.
  let targets = narrowed
  if (allowlist && narrowed.length === 0 && addressable.length > 0) {
    console.error(
      "[wa-bridge-alert] WA_BRIDGE_ALERT_RECIPIENTS matched no active admin — "
      + `paging all ${addressable.length} admin(s) instead. Check the value for a typo.`,
    )
    targets = addressable
  }

  let sent = 0
  for (const recipient of targets) {
    if (!recipient.email) continue
    try {
      const result = await sendEmail({
        tenantId,
        to: recipient.email,
        toName: recipient.name ?? "Admin",
        subject: `[${decision.severity}] WhatsApp bridge status changed`,
        html: alertEmailHtml(decision),
        category: "wa_bridge_alert",
      })
      if (result.ok) sent++
    } catch (error) {
      // One bad recipient (DB hiccup, recipient-check failure) must not
      // suppress the alert for the rest of the admins — this loop IS the
      // outage notification path.
      // Log the user id, not the address: lib/email/service.ts's own failure
      // logs deliberately carry tenantId/category/referenceId and never the
      // recipient, and this line is still enough to identify who missed the
      // alert.
      console.error(`[wa-bridge-alert] send failed for user ${recipient.id}:`, error)
    }
  }
  return sent
}
