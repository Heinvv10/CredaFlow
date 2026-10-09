import { NextRequest, NextResponse } from "next/server"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { logAudit, AuditAction } from "@/lib/audit"
import { promoteWaBridgeNumber } from "@/lib/whatsapp-bridge-admin"
import { logWaBridgeActionFailed } from "../../../audit-attempt"

type RouteContext = { params: Promise<{ slotId: string }> }

export async function POST(req: NextRequest, { params }: RouteContext): Promise<Response> {
  const guard = await requireApiRole("ADMIN")
  if (guard.error) return guard.error
  const { slotId } = await params
  return withTenantContext(req, async (tenant) => {
    try {
      await promoteWaBridgeNumber(slotId)
      await logAudit({
        tenantId: tenant.id, userId: guard.user.id, userEmail: guard.user.email,
        action: AuditAction.WA_BRIDGE_NUMBER_PROMOTED, entity: "WaBridgeNumber", entityId: slotId,
      })
      return NextResponse.json({ ok: true })
    } catch (err) {
      // A promote redirects ALL outbound WhatsApp to a different number. If the
      // bridge applied it and the response was lost, the pool is live on a
      // number with no record of who moved it there.
      await logWaBridgeActionFailed({
        tenantId: tenant.id, userId: guard.user.id, userEmail: guard.user.email,
        action: AuditAction.WA_BRIDGE_NUMBER_PROMOTED, slotId, error: err,
      })
      const message = err instanceof Error ? err.message : "failed to promote number"
      return NextResponse.json({ error: message }, { status: 502 })
    }
  })
}
