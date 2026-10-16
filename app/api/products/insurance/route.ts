import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { fspRequiredResponse, lenderHoldsFsp } from "@/lib/insurance/require-fsp"
import { withTenantContext } from "@/lib/tenant"
import { logAudit } from "@/lib/audit"
import {
  CREDIT_LIFE_PRODUCT_TERMS_ERROR,
  creditLifeProductTermsIssues,
} from "@/lib/insurance/credit-life-product-terms"

export async function GET(req: NextRequest) {
  const guard = await requireApiRole("READONLY")
  if (guard.error) return guard.error
  return withTenantContext(req, async (tenant) => {
    const products = await prisma.insuranceProduct.findMany({ where: { tenantId: tenant.id }, orderBy: { name: "asc" } })
    const serialized = products.map(p => ({ ...p, premiumAmount: Number(p.premiumAmount), sumAssured: Number(p.sumAssured), commissionRate: Number(p.commissionRate) }))
    return NextResponse.json(serialized)
  })
}

export async function POST(req: NextRequest) {
  const guard = await requireApiRole("ADMIN")
  if (guard.error) return guard.error
  return withTenantContext(req, async (tenant) => {
    const body = await req.json()
    const premiumAmount = Number(body.premiumAmount)
    const sumAssured = Number(body.sumAssured)

    const termsIssues = creditLifeProductTermsIssues({ type: body.type, premiumAmount, sumAssured })
    if (termsIssues.length > 0) {
      return NextResponse.json({ error: CREDIT_LIFE_PRODUCT_TERMS_ERROR, invalidFields: termsIssues }, { status: 422 })
    }

    // A lender with no FSP number offers no cover: an active credit-life
    // product would be an offer (the approval guard counts it as one).
    if (body.type === "CREDIT_LIFE" && (body.active ?? true) && !(await lenderHoldsFsp(prisma as unknown as Parameters<typeof lenderHoldsFsp>[0], tenant.id))) {
      return fspRequiredResponse()
    }

    // Validate the underwriter belongs to this tenant before writing the FK —
    // the DB FK only enforces existence, not tenancy (defence-in-depth IDOR).
    if (body.insurerId) {
      const ins = await prisma.insurer.findFirst({ where: { id: body.insurerId, tenantId: tenant.id }, select: { id: true } })
      if (!ins) return NextResponse.json({ error: "Invalid insurerId" }, { status: 400 })
    }

    const product = await prisma.insuranceProduct.create({
      data: {
        tenantId: tenant.id,
        code: body.code,
        name: body.name,
        type: body.type,
        premiumAmount,
        sumAssured,
        commissionRate: Number(body.commissionRate ?? 0.15),
        active: body.active ?? true,
        insurerId: body.insurerId || null,
      },
    })

    void logAudit({
      tenantId: tenant.id,
      userId: guard.user.id,
      userEmail: guard.user.email,
      action: "INSURANCE_PRODUCT_CREATED",
      entity: "InsuranceProduct",
      entityId: product.id,
      newValue: {
        code: product.code, name: product.name, type: product.type,
        premiumAmount: Number(product.premiumAmount), sumAssured: Number(product.sumAssured),
        commissionRate: Number(product.commissionRate), active: product.active,
        insurerId: product.insurerId,
      },
    })

    return NextResponse.json({ ...product, premiumAmount: Number(product.premiumAmount), sumAssured: Number(product.sumAssured), commissionRate: Number(product.commissionRate) }, { status: 201 })
  })
}
