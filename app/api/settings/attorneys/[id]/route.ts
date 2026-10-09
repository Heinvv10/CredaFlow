import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { logAudit } from "@/lib/audit"

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireApiRole("LOAN_ADMIN")
  if (guard.error) return guard.error

  return withTenantContext(req, async (tenant) => {
    const { id } = await params
    const body = await req.json() as {
      name?: string
      contactPerson?: string
      phone?: string
      email?: string
      address?: string
      specialisation?: string
      active?: boolean
    }

    const existing = await prisma.attorneyFirm.findUnique({
      where: { id },
      select: { tenantId: true },
    })

    if (!existing || existing.tenantId !== tenant.id) {
      return NextResponse.json({ error: "Not found" }, { status: 404 })
    }

    const updated = await prisma.attorneyFirm.update({
      where: { id },
      data: {
        ...(body.name != null ? { name: body.name.trim() } : {}),
        ...(body.contactPerson !== undefined ? { contactPerson: body.contactPerson?.trim() || null } : {}),
        ...(body.phone !== undefined ? { phone: body.phone?.trim() || null } : {}),
        ...(body.email !== undefined ? { email: body.email?.trim() || null } : {}),
        ...(body.address !== undefined ? { address: body.address?.trim() || null } : {}),
        ...(body.specialisation !== undefined ? { specialisation: body.specialisation?.trim() || null } : {}),
        ...(body.active !== undefined ? { active: body.active } : {}),
      },
    })

    await logAudit({
      tenantId: tenant.id,
      action: "ATTORNEY_FIRM_UPDATED",
      entity: "AttorneyFirm",
      entityId: id,
      userId: guard.user.id,
      newValue: body,
    })

    return NextResponse.json(updated)
  })
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireApiRole("LOAN_ADMIN")
  if (guard.error) return guard.error

  return withTenantContext(req, async (tenant) => {
    const { id } = await params

    const existing = await prisma.attorneyFirm.findUnique({
      where: { id },
      select: { tenantId: true, _count: { select: { referrals: true } } },
    })

    if (!existing || existing.tenantId !== tenant.id) {
      return NextResponse.json({ error: "Not found" }, { status: 404 })
    }

    if (existing._count.referrals > 0) {
      await prisma.attorneyFirm.update({ where: { id }, data: { active: false } })

      await logAudit({
        tenantId: tenant.id,
        action: "ATTORNEY_FIRM_DEACTIVATED",
        entity: "AttorneyFirm",
        entityId: id,
        userId: guard.user.id,
        newValue: { active: false, reason: "has_referrals" },
      })

      return NextResponse.json({ deactivated: true })
    }

    await prisma.attorneyFirm.delete({ where: { id } })

    await logAudit({
      tenantId: tenant.id,
      action: "ATTORNEY_FIRM_DELETED",
      entity: "AttorneyFirm",
      entityId: id,
      userId: guard.user.id,
    })

    return NextResponse.json({ deleted: true })
  })
}
