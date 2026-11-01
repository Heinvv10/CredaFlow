import { NextRequest, NextResponse } from "next/server"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { requireApiRole } from "@/lib/auth-guards"
import { canDo } from "@/lib/permissions"
import { memberIdNumbers, resolveMembers } from "@/lib/product-types/groups"
import { prisma } from "@/lib/prisma"
import { withTenantContext } from "@/lib/tenant"

/** Replaces a group's members: { memberIdNumbers }. A group keeps at least two. */
export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireApiRole("CREDIT_OFFICER")
  if (guard.error) return guard.error
  if (!canDo(guard.user.role, "manage_borrower_groups")) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  return withTenantContext(req, async (tenant) => {
    const { id } = await params
    const body = (await req.json().catch(() => null)) as { memberIdNumbers?: unknown } | null
    const ids = memberIdNumbers(body?.memberIdNumbers)
    if (!ids) return NextResponse.json({ error: "memberIdNumbers: at least two different ID numbers" }, { status: 422 })
    const group = await prisma.borrowerGroup.findFirst({ where: { id, tenantId: tenant.id }, select: { id: true } })
    if (!group) return NextResponse.json({ error: "Not found" }, { status: 404 })
    const members = await resolveMembers(prisma, tenant.id, ids)
    if ("missing" in members) return NextResponse.json({ error: `No client with ID number ${members.missing.join(", ")}` }, { status: 422 })
    await prisma.$transaction(async (tx) => {
      const before = await tx.borrowerGroupMember.findMany({ where: { tenantId: tenant.id, groupId: id }, select: { clientId: true } })
      await tx.borrowerGroupMember.deleteMany({ where: { tenantId: tenant.id, groupId: id } })
      await tx.borrowerGroupMember.createMany({ data: members.clientIds.map((clientId) => ({ tenantId: tenant.id, groupId: id, clientId, addedById: guard.user.id })) })
      await logAuditStrict({ tenantId: tenant.id, userId: guard.user.id, userEmail: guard.user.email, action: AuditAction.BORROWER_GROUP_MEMBERS_CHANGED, entity: "BorrowerGroup", entityId: id, oldValue: { clientIds: before.map((m) => m.clientId) }, newValue: { clientIds: members.clientIds } }, tx)
    })
    return NextResponse.json({ ok: true })
  })
}
