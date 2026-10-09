import { NextRequest, NextResponse } from "next/server"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { logAudit, AuditAction } from "@/lib/audit"
import { relinkWaBridgeNumber } from "@/lib/whatsapp-bridge-admin"
import { logWaBridgeActionFailed } from "../../../audit-attempt"

type RouteContext = { params: Promise<{ slotId: string }> }

/**
 * Re-pairs a slot whose WhatsApp session was revoked, without the operator
 * having to Retire and then Add — two steps that leave the pool empty if the
 * second is abandoned, and where the Add would ask for a new-number
 * confirmation that is meaningless for a number this bridge already owns.
 */
export async function POST(req: NextRequest, { params }: RouteContext): Promise<Response> {
  const guard = await requireApiRole("ADMIN")
  if (guard.error) return guard.error
  const { slotId } = await params
  return withTenantContext(req, async (tenant) => {
    try {
      const result = await relinkWaBridgeNumber(slotId)
      await logAudit({
        tenantId: tenant.id, userId: guard.user.id, userEmail: guard.user.email,
        action: AuditAction.WA_BRIDGE_NUMBER_RELINKED, entity: "WaBridgeNumber", entityId: slotId,
        newValue: { newSlotId: result.slotId },
      })
      return NextResponse.json(result)
    } catch (err) {
      // A relink retires the old slot BEFORE pairing, so a failure can leave
      // the number unpaired — the outcome genuinely is uncertain.
      await logWaBridgeActionFailed({
        tenantId: tenant.id, userId: guard.user.id, userEmail: guard.user.email,
        action: AuditAction.WA_BRIDGE_NUMBER_RELINKED, slotId, error: err,
      })
      const message = err instanceof Error ? err.message : "failed to re-link number"
      const status = (err as { status?: number })?.status === 409 ? 409 : 502
      return NextResponse.json({ error: message, code: (err as { code?: string })?.code }, { status })
    }
  })
}
