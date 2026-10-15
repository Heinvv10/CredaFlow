// The gate every staff recovery route passes, in the order the other
// asset-finance routes use: a staff session (401), the session bound to the
// request's tenant (403), the tenant's asset-finance flag (404), then the
// permission (403). A lib result becomes a response: not_found 404, not_ready 409.
import { NextResponse } from "next/server"
import { canDo, requireApiRole, type PermissionKey } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import type { RecoveryActor } from "./recovery-create"
import type { RecoveryResult } from "./recovery-result"
import { requireAssetFinanceEnabled } from "./require-enabled"

export async function withRecoveryStaff(
  req: Request,
  permission: PermissionKey | null,
  handler: (actor: RecoveryActor) => Promise<Response>,
): Promise<Response> {
  const guard = await requireApiRole("READONLY")
  if (guard.error) return guard.error
  return withTenantContext(req, async (tenant) => {
    const disabled = await requireAssetFinanceEnabled(tenant.id)
    if (disabled) return disabled
    if (permission && !canDo(guard.user.role, permission)) return NextResponse.json({ error: `This step needs the ${permission} permission` }, { status: 403 })
    return handler({ tenantId: tenant.id, userId: guard.user.id, userEmail: guard.user.email })
  })
}

export function recoveryResponse(result: RecoveryResult, notFound = "Recovery not found", created = false): NextResponse {
  if (result.kind === "not_found") return NextResponse.json({ error: notFound }, { status: 404 })
  if (result.kind === "not_ready") return NextResponse.json({ error: result.reason }, { status: 409 })
  return NextResponse.json(result, { status: created ? 201 : 200 })
}

export function invalidBody(fields: Record<string, string>): NextResponse {
  return NextResponse.json({ error: "Invalid request", fields }, { status: 400 })
}
