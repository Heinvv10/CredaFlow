import { NextRequest, NextResponse } from "next/server"
import { requireCommsAgent } from "@/lib/inbox/authz"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { listStaffForRoster, setCommsAgent } from "@/lib/inbox/roster"

export async function GET(req: NextRequest) {
  const guard = await requireCommsAgent()
  if (guard.error) return guard.error
  return withTenantContext(req, async (tenant) => NextResponse.json(await listStaffForRoster(tenant.id)))
}

export async function PATCH(req: NextRequest) {
  const guard = await requireApiRole("ADMIN")
  if (guard.error) return guard.error
  const body = (await req.json()) as { userId?: string; isCommsAgent?: boolean }
  if (!body.userId || typeof body.isCommsAgent !== "boolean") {
    return NextResponse.json({ error: "userId and isCommsAgent required" }, { status: 400 })
  }
  return withTenantContext(req, async (tenant) => {
    const res = await setCommsAgent({ tenantId: tenant.id, userId: body.userId!, isCommsAgent: body.isCommsAgent!, actorUserId: guard.user.id, actorEmail: guard.user.email })
    if (!res.ok) return NextResponse.json({ error: "not found" }, { status: 404 })
    return NextResponse.json({ ok: true })
  })
}
