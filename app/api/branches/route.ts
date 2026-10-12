import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { withTenantContext } from "@/lib/tenant"
import { canDo, requireApiRole } from "@/lib/auth-guards"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { BRANCH_MANAGER_ROLES } from "@/lib/permissions"

export async function GET(req: NextRequest) {
  const guard = await requireApiRole("READONLY")
  if (guard.error) return guard.error

  return withTenantContext(req, async (tenant) => {
    const branches = await prisma.branch.findMany({
      where: { tenantId: tenant.id },
      orderBy: { name: "asc" },
      include: {
        _count: {
          select: { users: true, applications: true, clients: true },
        },
      },
    })

    return NextResponse.json(branches)
  })
}

export async function POST(req: NextRequest) {
  const guard = await requireApiRole("ADMIN")
  if (guard.error) return guard.error

  if (!canDo(guard.user.role, "manage_branches")) {
    return NextResponse.json({ error: "Insufficient permissions" }, { status: 403 })
  }

  return withTenantContext(req, async (tenant) => {
    const body = await req.json() as { name: string; code: string; address?: string; phone?: string; managerId?: string }

    if (!body.name || !body.code) {
      return NextResponse.json({ error: "name and code are required" }, { status: 400 })
    }
    if (body.managerId != null && typeof body.managerId !== "string") {
      return NextResponse.json({ error: "managerId must be a string" }, { status: 400 })
    }

    // managerId has no FK and User is not tenant-scoped, so an unchecked value
    // would store another tenant's user. Only the active staff the settings
    // page offers as managers are accepted; anyone else, in this tenant or
    // another, answers exactly as an id that does not exist.
    if (
      body.managerId &&
      !(await prisma.user.findFirst({
        where: { id: body.managerId, tenantId: tenant.id, active: true, role: { in: BRANCH_MANAGER_ROLES } },
        select: { id: true },
      }))
    ) {
      return NextResponse.json({ error: "Manager not found" }, { status: 404 })
    }

    // The branch and its audit row commit together.
    const branch = await prisma.$transaction(async (tx) => {
      const created = await tx.branch.create({
        data: {
          tenantId: tenant.id,
          name: body.name,
          code: body.code.toUpperCase(),
          address: body.address ?? null,
          phone: body.phone ?? null,
          managerId: body.managerId || null,
        },
      })
      await logAuditStrict({
        tenantId: tenant.id,
        userId: guard.user.id,
        userEmail: guard.user.email,
        action: AuditAction.BRANCH_CREATED,
        entity: "Branch",
        entityId: created.id,
        newValue: { name: created.name, code: created.code, managerId: created.managerId },
      }, tx)
      return created
    })

    return NextResponse.json(branch, { status: 201 })
  })
}
