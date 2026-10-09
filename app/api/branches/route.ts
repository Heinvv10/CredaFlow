import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { withTenantContext } from "@/lib/tenant"
import { canDo, requireApiRole } from "@/lib/auth-guards"

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

    const branch = await prisma.branch.create({
      data: {
        tenantId: tenant.id,
        name: body.name,
        code: body.code.toUpperCase(),
        address: body.address ?? null,
        phone: body.phone ?? null,
        managerId: body.managerId ?? null,
      },
    })

    return NextResponse.json(branch, { status: 201 })
  })
}
