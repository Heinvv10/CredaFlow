import { NextRequest, NextResponse } from "next/server"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { logAudit, AuditAction } from "@/lib/audit"
import { setWaBridgeNumberPriority, retireWaBridgeNumber } from "@/lib/whatsapp-bridge-admin"
import { logWaBridgeActionFailed } from "../../audit-attempt"

type RouteContext = { params: Promise<{ slotId: string }> }

export async function PATCH(req: NextRequest, { params }: RouteContext): Promise<Response> {
  const guard = await requireApiRole("ADMIN")
  if (guard.error) return guard.error
  const { slotId } = await params
  const body = (await req.json().catch(() => null)) as { priority?: number } | null
  if (typeof body?.priority !== "number") {
    return NextResponse.json({ error: "priority (number) is required" }, { status: 400 })
  }
  return withTenantContext(req, async (tenant) => {
    try {
      await setWaBridgeNumberPriority(slotId, body.priority!)
      await logAudit({
        tenantId: tenant.id, userId: guard.user.id, userEmail: guard.user.email,
        action: AuditAction.WA_BRIDGE_NUMBER_REORDERED, entity: "WaBridgeNumber", entityId: slotId,
        newValue: { priority: body.priority },
      })
      return NextResponse.json({ ok: true })
    } catch (err) {
      await logWaBridgeActionFailed({
        tenantId: tenant.id, userId: guard.user.id, userEmail: guard.user.email,
        action: AuditAction.WA_BRIDGE_NUMBER_REORDERED, slotId, error: err,
        detail: { priority: body.priority },
      })
      const message = err instanceof Error ? err.message : "failed to update priority"
      return NextResponse.json({ error: message }, { status: 502 })
    }
  })
}

export async function DELETE(req: NextRequest, { params }: RouteContext): Promise<Response> {
  const guard = await requireApiRole("ADMIN")
  if (guard.error) return guard.error
  const { slotId } = await params
  return withTenantContext(req, async (tenant) => {
    try {
      const { authDirRemoved } = await retireWaBridgeNumber(slotId)
      await logAudit({
        tenantId: tenant.id, userId: guard.user.id, userEmail: guard.user.email,
        action: AuditAction.WA_BRIDGE_NUMBER_RETIRED, entity: "WaBridgeNumber", entityId: slotId,
        newValue: { authDirRemoved },
      })
      // The number IS retired either way; stale session files left on disk are
      // an ops cleanup, surfaced so nobody has to read container logs for it.
      return NextResponse.json({ ok: true, authDirRemoved })
    } catch (err) {
      await logWaBridgeActionFailed({
        tenantId: tenant.id, userId: guard.user.id, userEmail: guard.user.email,
        action: AuditAction.WA_BRIDGE_NUMBER_RETIRED, slotId, error: err,
      })
      const message = err instanceof Error ? err.message : "failed to retire number"
      return NextResponse.json({ error: message }, { status: 502 })
    }
  })
}
