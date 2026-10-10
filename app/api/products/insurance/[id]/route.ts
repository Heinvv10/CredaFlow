import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { logAudit } from "@/lib/audit"
import {
  CREDIT_LIFE_PRODUCT_TERMS_ERROR,
  creditLifeProductTermsIssues,
} from "@/lib/insurance/credit-life-product-terms"

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireApiRole("READONLY")
  if (guard.error) return guard.error
  return withTenantContext(req, async (tenant) => {
    const { id } = await params
    const p = await prisma.insuranceProduct.findUnique({ where: { id, tenantId: tenant.id } })
    if (!p) return NextResponse.json({ error: "Not found" }, { status: 404 })
    return NextResponse.json({ ...p, premiumAmount: Number(p.premiumAmount), sumAssured: Number(p.sumAssured), commissionRate: Number(p.commissionRate) })
  })
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireApiRole("ADMIN")
  if (guard.error) return guard.error
  return withTenantContext(req, async (tenant) => {
    const { id } = await params
    const body = await req.json()

    const before = await prisma.insuranceProduct.findUnique({ where: { id, tenantId: tenant.id } })
    if (!before) return NextResponse.json({ error: "Not found" }, { status: 404 })

    const premiumAmount = Number(body.premiumAmount)
    const sumAssured = Number(body.sumAssured)
    // An absent type leaves the stored one in place, so judge that one.
    const termsIssues = creditLifeProductTermsIssues({ type: body.type ?? before.type, premiumAmount, sumAssured })
    if (termsIssues.length > 0) {
      return NextResponse.json({ error: CREDIT_LIFE_PRODUCT_TERMS_ERROR, invalidFields: termsIssues }, { status: 422 })
    }

    // Validate the underwriter belongs to this tenant before writing the FK —
    // the DB FK only enforces existence, not tenancy (defence-in-depth IDOR).
    if (body.insurerId) {
      const ins = await prisma.insurer.findFirst({ where: { id: body.insurerId, tenantId: tenant.id }, select: { id: true } })
      if (!ins) return NextResponse.json({ error: "Invalid insurerId" }, { status: 400 })
    }

    const p = await prisma.insuranceProduct.update({
      where: { id, tenantId: tenant.id },
      data: {
        code: body.code,
        name: body.name,
        type: body.type,
        premiumAmount,
        sumAssured,
        commissionRate: Number(body.commissionRate ?? 0.15),
        active: body.active,
        insurerId: body.insurerId || null,
      },
    })

    void logAudit({
      tenantId: tenant.id,
      userId: guard.user.id,
      userEmail: guard.user.email,
      action: "INSURANCE_PRODUCT_UPDATED",
      entity: "InsuranceProduct",
      entityId: id,
      oldValue: {
        code: before.code, name: before.name, type: before.type,
        premiumAmount: Number(before.premiumAmount), sumAssured: Number(before.sumAssured),
        commissionRate: Number(before.commissionRate), active: before.active,
        insurerId: before.insurerId,
      },
      newValue: {
        code: p.code, name: p.name, type: p.type,
        premiumAmount: Number(p.premiumAmount), sumAssured: Number(p.sumAssured),
        commissionRate: Number(p.commissionRate), active: p.active,
        insurerId: p.insurerId,
      },
    })

    return NextResponse.json({ ...p, premiumAmount: Number(p.premiumAmount), sumAssured: Number(p.sumAssured), commissionRate: Number(p.commissionRate) })
  })
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireApiRole("ADMIN")
  if (guard.error) return guard.error
  return withTenantContext(req, async (tenant) => {
    const { id } = await params

    const before = await prisma.insuranceProduct.findUnique({ where: { id, tenantId: tenant.id } })
    if (!before) return NextResponse.json({ error: "Not found" }, { status: 404 })

    await prisma.insuranceProduct.update({ where: { id, tenantId: tenant.id }, data: { active: false } })

    void logAudit({
      tenantId: tenant.id,
      userId: guard.user.id,
      userEmail: guard.user.email,
      action: "INSURANCE_PRODUCT_DEACTIVATED",
      entity: "InsuranceProduct",
      entityId: id,
      oldValue: { active: before.active },
      newValue: { active: false },
    })

    return NextResponse.json({ success: true })
  })
}
