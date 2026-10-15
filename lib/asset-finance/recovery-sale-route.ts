import { NextRequest, NextResponse } from "next/server"
import { canDo, requireApiRole, type PermissionKey } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { requireAssetFinanceEnabled } from "./require-enabled"
import type { RecoveryActor } from "./recovery-create"

// The shared shell of the sale, proceeds, outcome and refund routes: session,
// tenant, module switch, permission (403), then the service's answer mapped to
// 404 / 409 / the success status. House pattern, see the surrender routes.

type Answer = { kind: "not_found" } | { kind: "not_ready"; reason: string } | { kind: "bad_request"; error: string } | ({ kind: "done" } & Record<string, unknown>)

export async function recoveryWrite(
  req: NextRequest,
  options: { permission: PermissionKey; denied: string; notFound: string; success?: number },
  run: (actor: RecoveryActor) => Promise<Answer>,
): Promise<Response> {
  const guard = await requireApiRole("READONLY")
  if (guard.error) return guard.error
  return withTenantContext(req, async (tenant) => {
    const disabled = await requireAssetFinanceEnabled(tenant.id)
    if (disabled) return disabled
    if (!canDo(guard.user.role, options.permission)) return NextResponse.json({ error: options.denied }, { status: 403 })
    const answer = await run({ tenantId: tenant.id, userId: guard.user.id, userEmail: guard.user.email })
    if (answer.kind === "not_found") return NextResponse.json({ error: options.notFound }, { status: 404 })
    if (answer.kind === "not_ready") return NextResponse.json({ error: answer.reason }, { status: 409 })
    if (answer.kind === "bad_request") return NextResponse.json({ error: answer.error }, { status: 400 })
    return NextResponse.json(answer, { status: options.success ?? 200 })
  })
}
