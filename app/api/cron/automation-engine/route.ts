import { NextRequest, NextResponse } from "next/server"
import { getTenantFromRequest } from "@/lib/tenant"
import { runAutomationEngine } from "@/lib/automation/engine"
import { verifyCronSecret } from "@/lib/cron-auth"

export async function GET(req: NextRequest): Promise<NextResponse> {
  const denied = verifyCronSecret(req)
  if (denied) return denied

  const tenant = await getTenantFromRequest(req)
  if (!tenant) {
    return NextResponse.json({ error: "Tenant not found" }, { status: 400 })
  }

  try {
    const result = await runAutomationEngine(tenant.id)
    console.log(`[cron/automation-engine] Done — ${result.ran} rules, ${result.actions} actions, ${result.errors} errors`)
    // A rule that threw is swallowed per-rule (see runAutomationEngine) so the
    // rest of the batch still runs, but a hardcoded ok:true here would hide a
    // rule that has been failing on every run from the systemd wrapper, which
    // only fails the unit on HTTP >= 400 and never parses this body.
    const ok = result.errors === 0
    return NextResponse.json(
      { ok, ...result, runAt: new Date().toISOString() },
      { status: ok ? 200 : 503 },
    )
  } catch (err) {
    console.error("[cron/automation-engine] Fatal error:", err)
    return NextResponse.json({ error: "Automation engine failed" }, { status: 500 })
  }
}
