import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { verifyCronSecret } from "@/lib/cron-auth"
import { getTenantFromRequest } from "@/lib/tenant"
import { getWabaTemplateCreds, WabaNotConfiguredError } from "@/lib/whatsapp-cloud-config"
import { fetchWabaTemplateStatus } from "@/lib/whatsapp/graph-templates"

/**
 * Polls Meta for approval status of PENDING WABA templates and advances
 * MessageTemplate.providerStatus. Auth: x-cron-secret (lib/cron-auth.ts);
 * /api/cron/ is allow-listed in lib/public-routes.ts.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const denied = verifyCronSecret(req)
  if (denied) return denied

  const tenant = await getTenantFromRequest(req)
  if (!tenant) return NextResponse.json({ error: "Tenant not found" }, { status: 400 })

  const pending = await prisma.messageTemplate.findMany({
    where: { tenantId: tenant.id, providerStatus: "PENDING", wabaTemplateName: { not: null } },
    select: { id: true, wabaTemplateName: true },
  })
  if (pending.length === 0) return NextResponse.json({ ok: true, checked: 0, updated: 0 })

  let creds
  try {
    creds = await getWabaTemplateCreds(tenant.id)
  } catch (e: unknown) {
    if (e instanceof WabaNotConfiguredError) {
      return NextResponse.json({ ok: true, checked: pending.length, updated: 0, skipped: "no_creds" })
    }
    throw e
  }

  let updated = 0
  let errors = 0
  for (const t of pending) {
    try {
      const status = await fetchWabaTemplateStatus(creds, t.wabaTemplateName!)
      if (status && status !== "PENDING") {
        await prisma.messageTemplate.update({
          where: { id: t.id, tenantId: tenant.id },
          data: { providerStatus: status },
        })
        updated++
      }
    } catch (e: unknown) {
      console.error(`[cron/poll-wa-templates] template ${t.id} status poll failed:`, e)
      errors++
    }
  }
  // A run where every poll failed achieved nothing, and the systemd wrapper
  // calls this with `curl -fsS`, which only fails the unit on HTTP >= 400 and
  // never parses this body — so returning 200 here would print
  // "[cron] …poll-wa-templates ok" while an expired WABA token blocks every
  // template approval from ever landing. Same shape as the sibling
  // check-wa-bridge-status, which fails when its upstream is unreachable.
  //
  // A PARTIAL failure intentionally stays 200: that batch still did real
  // work, and fetchWabaTemplateStatus (lib/whatsapp/graph-templates.ts) has
  // no retry/backoff of its own, so one transient Meta 5xx on one of N
  // templates would otherwise red the whole run every time it happens —
  // exactly the kind of flapping that trains an operator to stop trusting
  // (and start ignoring) the alert.
  if (errors > 0 && errors === pending.length) {
    return NextResponse.json(
      { ok: false, error: "all_template_polls_failed", checked: pending.length, updated, errors },
      { status: 503 },
    )
  }
  if (updated > 0) {
    // The only operator-visible signal that a template became sendable —
    // callCron discards the body, so an unlogged count is an invisible one.
    console.log(`[cron/poll-wa-templates] advanced ${updated}/${pending.length} template(s)`)
  }
  return NextResponse.json({ ok: true, checked: pending.length, updated, errors })
}
