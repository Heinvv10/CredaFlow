import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { verifyCronSecret } from "@/lib/cron-auth"
import { getTenantFromRequest } from "@/lib/tenant"
import { listWaBridgeNumbers } from "@/lib/whatsapp-bridge-admin"
import { decideWaBridgeAlert, sendWaBridgeAlert } from "@/lib/messaging/wa-bridge-alert"
import { isWaEnvOff } from "@/lib/whatsapp/env-switch"
import { logAudit, AuditAction } from "@/lib/audit"

// Sends the alert then marks the alarm active, in that order, and only when
// at least one recipient was actually alerted. A throw isn't the only
// failure mode: sendWaBridgeAlert swallows per-recipient failures and
// returns a COUNT, so it can resolve 0 without throwing (EmailConfig
// missing/inactive, or every recipient blocked by the allowlist guard --
// see lib/email/service.ts). If the alarm latched on a 0-delivery run,
// `!alarm?.active` would suppress every later poll forever with nobody ever
// notified. Either failure mode -- a throw, or a resolved 0 -- must leave
// the alarm unset so the NEXT poll retries rather than believing an alert
// already went out.
// An unresolved outage re-alerts on this interval. Without it the alarm
// latches on the FIRST poll of an outage and every later poll is suppressed:
// `transition` goes null once the mirror is updated, the all-down fallback is
// gated on `!alarm.active`, and the clear branch needs a CONNECTED slot that
// by definition does not exist while the channel is down. That produces
// exactly ONE email for an outage of any length -- if it is missed, the
// channel stays dead in silence, which is precisely the failure this
// monitor exists to prevent.
const RE_ALERT_AFTER_MS = 6 * 60 * 60 * 1000

type AlarmState = { active: boolean; lastAlertedAt: Date | null } | null

export function shouldFireOutageAlert(alarm: AlarmState, now: Date = new Date()): boolean {
  if (!alarm?.active) return true
  // Latched but we never recorded when: re-alert rather than stay silent.
  if (!alarm.lastAlertedAt) return true
  return now.getTime() - alarm.lastAlertedAt.getTime() >= RE_ALERT_AFTER_MS
}

// Sends the alert then marks the alarm active, in that order, and only when
// at least one recipient was actually alerted. A throw isn't the only
// failure mode: sendWaBridgeAlert swallows per-recipient failures and
// returns a COUNT, so it can resolve 0 without throwing (EmailConfig
// missing/inactive, or every recipient blocked by the allowlist guard --
// see lib/email/service.ts). If the alarm latched on a 0-delivery run,
// `!alarm?.active` would suppress every later poll forever with nobody ever
// notified. Either failure mode -- a throw, or a resolved 0 -- must leave
// the alarm unset so the NEXT poll retries rather than believing an alert
// already went out.
async function fireCriticalAlarm(
  tenantId: string,
  decision: { severity: "WARNING" | "CRITICAL"; message: string },
): Promise<number> {
  const alerted = await sendWaBridgeAlert(tenantId, decision)
  if (alerted === 0) {
    // The detector fired and the notification did not reach a single person:
    // no ADMIN/SUPER_ADMIN exists, none has an email, EmailConfig is inactive,
    // or the recipient allowlist blocked every address. Not latching (below)
    // is right — the next poll retries — but a retry loop nobody can see is
    // its own silent outage, so leave durable evidence in the one store this
    // lender treats as authoritative.
    await logAudit({
      tenantId,
      action: AuditAction.WA_BRIDGE_ALERT_UNDELIVERABLE,
      entity: "WaBridgeAlarm",
      entityId: "singleton",
      newValue: { severity: decision.severity, message: decision.message },
    })
  }
  // Only a CRITICAL latches. A WARNING means traffic failed over and the
  // channel is still UP -- latching on it would arm the suppression that
  // gates the all-down and bridge-unreachable branches, so a total outage
  // minutes later would be silent. WARNING can't storm anyway: it fires only
  // on a CONNECTED->down transition, which stops recurring once the mirror
  // is written.
  if (alerted > 0 && decision.severity === "CRITICAL") {
    await prisma.waBridgeAlarm.upsert({
      where: { id: "singleton" },
      create: { id: "singleton", active: true, lastAlertedAt: new Date() },
      update: { active: true, lastAlertedAt: new Date() },
    })
  }
  return alerted
}

/**
 * Polls the WA bridge's /numbers, mirrors state into WaBridgeNumber, and
 * emails ADMIN/SUPER_ADMIN staff on a disconnect or full-pool outage. Auth:
 * x-cron-secret (lib/cron-auth.ts); /api/cron/ is allow-listed in
 * lib/public-routes.ts.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const denied = verifyCronSecret(req)
  if (denied) return denied

  // An environment with WhatsApp switched off has nothing to monitor. This
  // cron runs in-process in EVERY environment, and listWaBridgeNumbers()
  // throws when WA_SENDER_URL is unset, so without a skip that throw would
  // land in the same catch as a real outage and email ADMINs a false CRITICAL
  // wherever WhatsApp simply isn't set up.
  //
  // "Switched off" is any WA_ENABLED other than true (fail-closed parser,
  // lib/whatsapp/env-switch.ts). WA_ENABLED UNSET with no
  // WA_SENDER_URL is the same thing for a bridge: nobody opted in, and a
  // CRITICAL about a bridge no one configured is a false alarm. Set explicitly
  // without a URL, it still alerts below.
  if (isWaEnvOff() || (process.env.WA_ENABLED === undefined && !process.env.WA_SENDER_URL)) {
    return NextResponse.json({ ok: true, skipped: "wa_disabled" })
  }

  const tenant = await getTenantFromRequest(req)
  if (!tenant) return NextResponse.json({ error: "Tenant not found" }, { status: 400 })

  // A tenant on the Cloud API has retired the bridge, so its slot pool is
  // empty BY DESIGN -- and every branch below reads that as an outage. The
  // empty pool is vacuously `allDown`, so this cron emails every ADMIN a
  // CRITICAL once per RE_ALERT_AFTER_MS about a component nothing sends
  // through any more. That is not a monitor, it is a trainer: it teaches the
  // people who get paged that this subject line is safe to delete, and the
  // next one they ignore will be a real outage.
  //
  // Deliberately keyed on waProvider rather than deleting the cron. The
  // bridge machinery still exists for any tenant still on WA_UNOFFICIAL, and
  // resolveProvider (lib/messaging/send.ts) reads this exact column to decide
  // where a WhatsApp send actually goes -- so the monitor now watches the
  // bridge in precisely the case where the bridge is what delivers. Cloud API
  // delivery reports its own failures through lib/messaging/providers.ts.
  const commsSettings = await prisma.commsSettings.findUnique({
    where: { tenantId: tenant.id },
    select: { waProvider: true },
  })
  if (commsSettings?.waProvider === "WA_CLOUD") {
    return NextResponse.json({ ok: true, skipped: "wa_cloud" })
  }

  // WhatsApp is ENABLED but no bridge URL is configured. This is NOT the
  // benign "not provisioned" case: lib/whatsapp.ts's getWaSenderUrl() falls
  // back to a hardcoded third-party host, so outbound customer messages --
  // including NCA Section 129 notices -- may be flowing through a bridge this
  // monitor cannot see. Reporting ok:true here is exactly the
  // monitoring-nothing-while-claiming-healthy shape the feature exists to
  // kill, so treat it as an outage and alert.
  if (!process.env.WA_SENDER_URL) {
    const alarm = await prisma.waBridgeAlarm.findUnique({ where: { id: "singleton" } })
    let alerted = 0
    let alert: "CRITICAL" | null = null
    if (shouldFireOutageAlert(alarm)) {
      alert = "CRITICAL"
      alerted = await fireCriticalAlarm(tenant.id, {
        severity: "CRITICAL",
        message:
          "WhatsApp is enabled but WA_SENDER_URL is not configured, so the bridge cannot be monitored and outbound messages may be routing to an unintended host. Check the app container's environment.",
      })
    }
    return NextResponse.json({ ok: false, error: "wa_sender_url_missing", alert, alerted }, { status: 500 })
  }

  const previous = await prisma.waBridgeNumber.findMany({ select: { slotId: true, status: true } })

  let current
  try {
    current = await listWaBridgeNumbers()
  } catch (e) {
    console.error("[cron/check-wa-bridge-status] bridge unreachable:", e)
    // The bridge container itself being unreachable (crashed, network
    // partition, bad WA_SENDER_URL) is a silent outage of its own -- the
    // whole channel is gone, not just one slot. Gated by the same alarm
    // flag as the "everything logged out" case so it can't storm, and
    // deliberately does NOT touch WaBridgeNumber: we can't write state we
    // couldn't read.
    const alarm = await prisma.waBridgeAlarm.findUnique({ where: { id: "singleton" } })
    let alerted = 0
    let alert: "CRITICAL" | null = null
    if (shouldFireOutageAlert(alarm)) {
      alert = "CRITICAL"
      alerted = await fireCriticalAlarm(tenant.id, {
        severity: "CRITICAL",
        message: "The WhatsApp bridge could not be reached or its status could not be read (this may be a connectivity, credential, or version problem). Outbound WhatsApp may be affected.",
      })
    }
    return NextResponse.json({ ok: false, error: "bridge unreachable", alert, alerted }, { status: 502 })
  }

  await Promise.all(
    current.map((slot) =>
      prisma.waBridgeNumber.upsert({
        where: { slotId: slot.slotId },
        create: {
          slotId: slot.slotId, number: slot.number, status: slot.status, priority: slot.priority,
          connectedAt: slot.connectedAt ? new Date(slot.connectedAt) : null,
          disconnectedAt: slot.disconnectedAt ? new Date(slot.disconnectedAt) : null,
          lastDisconnectReason: slot.lastDisconnectReason,
        },
        update: {
          number: slot.number, status: slot.status, priority: slot.priority,
          connectedAt: slot.connectedAt ? new Date(slot.connectedAt) : null,
          disconnectedAt: slot.disconnectedAt ? new Date(slot.disconnectedAt) : null,
          lastDisconnectReason: slot.lastDisconnectReason,
        },
      }),
    ),
  )

  // Drop mirror rows for slots the bridge no longer reports. The upserts above
  // only ever ADD, so a retired number would linger forever. Harmless to
  // the alert path today (`allDown` and the transition diff both read
  // `current`), but `previous` feeds decideWaBridgeAlert, so a stale
  // CONNECTED row would eventually manufacture a phantom disconnect for a
  // number that no longer exists. Scoped to slots we just polled, so a bridge
  // that returned nothing because it is broken cannot wipe the mirror -- that
  // path throws above and never reaches here.
  const liveSlotIds = current.map((s) => s.slotId)
  await prisma.waBridgeNumber.deleteMany({ where: { slotId: { notIn: liveSlotIds } } })

  // decideWaBridgeAlert is a two-snapshot diff: it only fires on a
  // CONNECTED->bad transition, so it cannot see a bridge that was ALREADY
  // down when this cron started polling (empty `previous`, or `previous`
  // stuck in the same bad state every poll). The WaBridgeAlarm singleton
  // closes that hole independently of per-slot status: force-fire CRITICAL
  // when everything is down and no unresolved alarm is on record yet, and
  // clear the alarm on recovery so the next outage can fire again.
  const transition = decideWaBridgeAlert(previous, current)
  // An empty pool (every number retired, or none paired yet) IS all-down,
  // not "nothing to report": Array.prototype.every on [] is vacuously true,
  // and that's the right answer here -- selectActiveSlot([]) returns null,
  // so outbound WhatsApp is completely dead. A `current.length > 0` guard
  // would suppress this on the theory it was only a cold-start window
  // (main() -> startHttpServer -> boot(), registerSlot synchronous inside
  // boot's loop), but that window is microseconds against a 5-minute poll --
  // the trade was backwards, and the empty pool is reachable through the
  // UI's own Retire action on the last remaining number.
  const allDown = current.every((s) => s.status !== "CONNECTED")
  const alarm = await prisma.waBridgeAlarm.findUnique({ where: { id: "singleton" } })

  const decision =
    transition ??
    (allDown && shouldFireOutageAlert(alarm)
      ? { severity: "CRITICAL" as const, message: "No WhatsApp number is connected. Outbound WhatsApp is down." }
      : null)

  let alerted = 0
  if (decision) {
    alerted = await fireCriticalAlarm(tenant.id, decision)
  } else if (current.some((s) => s.status === "CONNECTED")) {
    // Recovery clears the alarm so the NEXT outage can fire again.
    await prisma.waBridgeAlarm.updateMany({ where: { active: true }, data: { active: false } })
  }

  return NextResponse.json({ ok: true, checked: current.length, alert: decision?.severity ?? null, alerted })
}
