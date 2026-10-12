import { NextRequest, NextResponse } from "next/server"
import { requireCommsAgent } from "@/lib/inbox/authz"
import { refuseStaffUserWrite, requireApiRole } from "@/lib/auth-guards"
import { prisma } from "@/lib/prisma"
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
    // An edit of a staff user: the same gate as Settings → Users.
    const target = await prisma.user.findFirst({ where: { id: body.userId, tenantId: tenant.id }, select: { role: true } })
    if (!target) return NextResponse.json({ error: "not found" }, { status: 404 })
    const refused = await refuseStaffUserWrite(guard.user, { tenantId: tenant.id, targetId: body.userId, targetRole: target.role, assignedRole: undefined })
    if (refused) return refused
    const res = await setCommsAgent({ tenantId: tenant.id, userId: body.userId!, isCommsAgent: body.isCommsAgent!, actorUserId: guard.user.id, actorEmail: guard.user.email })
    if (!res.ok) return NextResponse.json({ error: "not found" }, { status: 404 })
    return NextResponse.json({ ok: true })
  })
}
