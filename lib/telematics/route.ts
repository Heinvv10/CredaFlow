// The gate every staff telematics route passes, in the house order: a staff
// session (401), the session bound to the request's tenant (403), the tenant's
// asset-finance flag (404), then the permission (403). A DEALER session never
// clears requireApiRole, and the dealer host 404s /api/asset-finance/* first.
import { NextResponse } from "next/server"
import { canDo, requireApiRole, type PermissionKey } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { requireAssetFinanceEnabled } from "@/lib/asset-finance/require-enabled"
import type { TelematicsActor, TelematicsResult } from "./result"

export type TelematicsStaff = TelematicsActor & { role: string }

export async function withTelematicsStaff(req: Request, permission: PermissionKey, handler: (actor: TelematicsStaff) => Promise<Response>): Promise<Response> {
  const guard = await requireApiRole("READONLY")
  if (guard.error) return guard.error
  return withTenantContext(req, async (tenant) => {
    const disabled = await requireAssetFinanceEnabled(tenant.id)
    if (disabled) return disabled
    if (!canDo(guard.user.role, permission)) return NextResponse.json({ error: `This needs the ${permission} permission` }, { status: 403 })
    return handler({ tenantId: tenant.id, userId: guard.user.id, userEmail: guard.user.email, role: guard.user.role })
  })
}

/** A lib result as a response: a refusal with its status, success as `{ ok: true, ...rest }`. */
export function telematicsResponse(result: TelematicsResult, created = false): NextResponse {
  if (result.kind === "refused") return NextResponse.json({ error: result.error, ...(result.fields ? { fields: result.fields } : {}) }, { status: result.status })
  const { kind: _kind, ...rest } = result
  return NextResponse.json({ ok: true, ...rest }, { status: created ? 201 : 200 })
}

export const jsonBody = (req: Request): Promise<unknown> => req.json().catch(() => null)
