import { Prisma } from "@prisma/client"
import { NextRequest, NextResponse } from "next/server"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { requireApiRole } from "@/lib/auth-guards"
import { canDo } from "@/lib/permissions"
import { memberIdNumbers, resolveMembers } from "@/lib/product-types/groups"
import { prisma } from "@/lib/prisma"
import { withTenantContext } from "@/lib/tenant"

const memberView = { client: { select: { id: true, firstName: true, lastName: true, idNumber: true } } }

/** The lender's lending groups, for staff who may name them. */
export async function GET(req: NextRequest) {
  const guard = await requireApiRole("CREDIT_OFFICER")
  if (guard.error) return guard.error
  if (!canDo(guard.user.role, "manage_borrower_groups")) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  return withTenantContext(req, async (tenant) => {
    const groups = await prisma.borrowerGroup.findMany({ where: { tenantId: tenant.id }, orderBy: { name: "asc" }, include: { members: { include: memberView } } })
    return NextResponse.json({ groups })
  })
}

/** A new lending group: { name, memberIdNumbers }. Members are the lender's existing clients, by ID number. */
export async function POST(req: NextRequest) {
  const guard = await requireApiRole("CREDIT_OFFICER")
  if (guard.error) return guard.error
  if (!canDo(guard.user.role, "manage_borrower_groups")) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  return withTenantContext(req, async (tenant) => {
    const body = (await req.json().catch(() => null)) as { name?: unknown; memberIdNumbers?: unknown } | null
    const name = typeof body?.name === "string" ? body.name.trim() : ""
    if (name.length < 2 || name.length > 100) return NextResponse.json({ error: "name: 2 to 100 characters" }, { status: 422 })
    const ids = memberIdNumbers(body?.memberIdNumbers)
    if (!ids) return NextResponse.json({ error: "memberIdNumbers: at least two different ID numbers" }, { status: 422 })
    const members = await resolveMembers(prisma, tenant.id, ids)
    if ("missing" in members) return NextResponse.json({ error: `No client with ID number ${members.missing.join(", ")}` }, { status: 422 })
    try {
      const group = await prisma.$transaction(async (tx) => {
        const created = await tx.borrowerGroup.create({ data: { tenantId: tenant.id, name, createdById: guard.user.id } })
        await tx.borrowerGroupMember.createMany({ data: members.clientIds.map((clientId) => ({ tenantId: tenant.id, groupId: created.id, clientId, addedById: guard.user.id })) })
        await logAuditStrict({ tenantId: tenant.id, userId: guard.user.id, userEmail: guard.user.email, action: AuditAction.BORROWER_GROUP_CREATED, entity: "BorrowerGroup", entityId: created.id, newValue: { name, clientIds: members.clientIds } }, tx)
        return created
      })
      return NextResponse.json({ group }, { status: 201 })
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return NextResponse.json({ error: `A group named ${name} already exists.` }, { status: 409 })
      throw error
    }
  })
}
