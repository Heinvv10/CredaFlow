import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { logAudit } from "@/lib/audit"

export async function GET(req: NextRequest) {
  const guard = await requireApiRole("READONLY")
  if (guard.error) return guard.error

  return withTenantContext(req, async (tenant) => {
    const { searchParams } = new URL(req.url)
    const includeInactive = searchParams.get("includeInactive") === "true"

    const firms = await prisma.attorneyFirm.findMany({
      where: {
        tenantId: tenant.id,
        ...(includeInactive ? {} : { active: true }),
      },
      orderBy: { name: "asc" },
    })

    return NextResponse.json(firms)
  })
}

export async function POST(req: NextRequest) {
  const guard = await requireApiRole("LOAN_ADMIN")
  if (guard.error) return guard.error

  return withTenantContext(req, async (tenant) => {
    const body = await req.json() as {
      name?: string
      contactPerson?: string
      phone?: string
      email?: string
      address?: string
      specialisation?: string
    }

    if (!body.name?.trim()) {
      return NextResponse.json({ error: "name is required" }, { status: 422 })
    }

    const firm = await prisma.attorneyFirm.create({
      data: {
        tenantId: tenant.id,
        name: body.name.trim(),
        contactPerson: body.contactPerson?.trim() || null,
        phone: body.phone?.trim() || null,
        email: body.email?.trim() || null,
        address: body.address?.trim() || null,
        specialisation: body.specialisation?.trim() || null,
      },
    })

    await logAudit({
      tenantId: tenant.id,
      action: "ATTORNEY_FIRM_CREATED",
      entity: "AttorneyFirm",
      entityId: firm.id,
      userId: guard.user.id,
      newValue: { name: firm.name },
    })

    return NextResponse.json(firm, { status: 201 })
  })
}
