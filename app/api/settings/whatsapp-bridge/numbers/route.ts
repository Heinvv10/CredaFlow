import { NextRequest, NextResponse } from "next/server"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { logAudit, AuditAction } from "@/lib/audit"
import { listWaBridgeNumbers, addWaBridgeNumber } from "@/lib/whatsapp-bridge-admin"
import { logWaBridgeActionFailed } from "../audit-attempt"

export async function GET(_req: NextRequest): Promise<Response> {
  const guard = await requireApiRole("ADMIN")
  if (guard.error) return guard.error
  try {
    const numbers = await listWaBridgeNumbers()
    return NextResponse.json({ numbers })
  } catch (err) {
    const message = err instanceof Error ? err.message : "failed to reach bridge"
    return NextResponse.json({ error: message }, { status: 502 })
  }
}

export async function POST(req: NextRequest): Promise<Response> {
  const guard = await requireApiRole("ADMIN")
  if (guard.error) return guard.error
  const body = (await req.json().catch(() => null)) as { number?: string; confirmNew?: boolean } | null
  if (!body?.number) {
    return NextResponse.json({ error: "number is required" }, { status: 400 })
  }
  return withTenantContext(req, async (tenant) => {
    try {
      const result = await addWaBridgeNumber(body.number!, body.confirmNew === true)
      await logAudit({
        tenantId: tenant.id, userId: guard.user.id, userEmail: guard.user.email,
        action: AuditAction.WA_BRIDGE_NUMBER_ADDED, entity: "WaBridgeNumber", entityId: result.slotId,
        newValue: { number: body.number, slotId: result.slotId },
      })
      return NextResponse.json(result)
    } catch (err) {
      // The bridge may have created and paired the slot before the response was
      // lost (the client aborts at 40s). Audit against the NUMBER, since the
      // slotId the bridge minted never reached us.
      await logWaBridgeActionFailed({
        tenantId: tenant.id, userId: guard.user.id, userEmail: guard.user.email,
        action: AuditAction.WA_BRIDGE_NUMBER_ADDED, slotId: "unknown", error: err,
        detail: { number: body.number },
      })
      const message = err instanceof Error ? err.message : "failed to add number"
      // A confirmable refusal is a 409 the UI turns into a checkbox, not a
      // 502 dead end.
      const status = (err as { status?: number })?.status === 409 ? 409 : 502
      return NextResponse.json({ error: message, code: (err as { code?: string })?.code }, { status })
    }
  })
}
