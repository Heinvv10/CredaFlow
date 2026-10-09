import { NextRequest, NextResponse } from "next/server"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { logAudit, AuditAction } from "@/lib/audit"
import { setWaBridgeNumberPaused } from "@/lib/whatsapp-bridge-admin"
import { logWaBridgeActionFailed } from "../../../audit-attempt"

type RouteContext = { params: Promise<{ slotId: string }> }

/**
 * Park a number (or put it back on the air) without touching its WhatsApp
 * session. Retire is the destructive one: it logs the number out, so only a
 * fresh pairing code brings it back. Pausing keeps the device linked, so
 * resuming needs no code and nobody holding the phone — which is what makes
 * rotating a rate-limited or restricted number a one-click operation.
 */
export async function POST(req: NextRequest, { params }: RouteContext): Promise<Response> {
  const guard = await requireApiRole("ADMIN")
  if (guard.error) return guard.error
  const { slotId } = await params
  const body = (await req.json().catch(() => null)) as { paused?: boolean } | null
  if (typeof body?.paused !== "boolean") {
    return NextResponse.json({ error: "paused (boolean) is required" }, { status: 400 })
  }
  const paused = body.paused
  const action = paused ? AuditAction.WA_BRIDGE_NUMBER_PAUSED : AuditAction.WA_BRIDGE_NUMBER_RESUMED
  return withTenantContext(req, async (tenant) => {
    try {
      await setWaBridgeNumberPaused(slotId, paused)
      await logAudit({
        tenantId: tenant.id, userId: guard.user.id, userEmail: guard.user.email,
        action, entity: "WaBridgeNumber", entityId: slotId, newValue: { paused },
      })
      return NextResponse.json({ ok: true, paused })
    } catch (err) {
      await logWaBridgeActionFailed({
        tenantId: tenant.id, userId: guard.user.id, userEmail: guard.user.email,
        action, slotId, error: err, detail: { paused },
      })
      const message = err instanceof Error ? err.message : "failed to change pause state"
      return NextResponse.json({ error: message }, { status: 502 })
    }
  })
}
