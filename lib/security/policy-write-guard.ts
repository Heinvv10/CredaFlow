/**
 * The guard every lender security-policy write goes through, as in
 * app/api/settings/security-policy: the caller is a SUPER_ADMIN of the tenant
 * whose sign-in verified a TOTP code, re-checked on their locked User row
 * inside the write's transaction (role and tokenVersion as they are now).
 */
import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"
import { prisma } from "@/lib/prisma"
import { refuseLockedStaffUserWrite, requireApiRole, staffUserWriteConflict } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { callerIp } from "@/lib/rate-limit"

type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0]

export type PolicyWriteContext = {
  tenantId: string
  actor: { id: string; email: string }
  ip: string
}

export async function superAdminPolicyWrite(
  req: NextRequest,
  /** Validates the body; a Response refuses the request before any write. */
  parse: (body: unknown, ctx: PolicyWriteContext) => Response | object,
  write: (tx: Tx, input: object, ctx: PolicyWriteContext) => Promise<Response>,
): Promise<Response> {
  const guard = await requireApiRole("SUPER_ADMIN")
  if (guard.error) return guard.error
  const actor = guard.user
  if (actor.totpVerified !== true) {
    return NextResponse.json(
      { error: "Sign in with two-factor authentication to change the security policy. Enable it under Settings → Security, then sign out and back in." },
      { status: 403 },
    )
  }
  return withTenantContext(req, async (tenant) => {
    const ctx: PolicyWriteContext = { tenantId: tenant.id, actor: { id: actor.id, email: actor.email }, ip: callerIp(req) }
    const input = parse(await req.json().catch(() => null), ctx)
    if (input instanceof Response) return input
    return prisma.$transaction(async (tx) => {
      const locked = await refuseLockedStaffUserWrite(tx, actor, { tenantId: tenant.id, assignedRole: undefined })
      if (locked.refused) return locked.refused
      if (locked.callerRole !== "SUPER_ADMIN") return NextResponse.json({ error: "Forbidden" }, { status: 403 })
      return write(tx, input, ctx)
    }).catch((err: unknown) => {
      const conflict = staffUserWriteConflict(err)
      if (conflict) return conflict
      throw err
    })
  }) as Promise<Response>
}
