import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { logAudit } from "@/lib/audit"
import { loanProductBoundsIssues } from "@/lib/product-config/bounds"
import { micro30ContractIssues } from "@/lib/product-config/micro30"

export async function GET(req: NextRequest) {
  const guard = await requireApiRole("READONLY")
  if (guard.error) return guard.error
  return withTenantContext(req, async (tenant) => {
    const products = await prisma.loanProduct.findMany({
      where: { tenantId: tenant.id },
      orderBy: { name: "asc" },
    })
    return NextResponse.json(products)
  })
}

export async function POST(req: NextRequest) {
  const guard = await requireApiRole("ADMIN")
  if (guard.error) return guard.error
  return withTenantContext(req, async (tenant) => {
    const body = await req.json()
    const boundsIssues = loanProductBoundsIssues(body)
    if (boundsIssues.length > 0) {
      return NextResponse.json(
        {
          error: "Amounts must be positive with a minimum no higher than the maximum, and terms must be whole days with a minimum no higher than the maximum.",
          invalidFields: boundsIssues,
        },
        { status: 422 },
      )
    }
    const data = {
      tenantId: tenant.id,
      code: body.code,
      name: body.name,
      productType: body.productType,
      minAmount: Math.round(body.minAmount * 100),
      maxAmount: Math.round(body.maxAmount * 100),
      minTermDays: Number(body.minTermDays),
      maxTermDays: Number(body.maxTermDays),
      interestRatePm: Number(body.interestRatePm) / 100,
      interestModel: body.interestModel,
      initiationFeeModel: body.initiationFeeModel === "NCA_REG42" ? "NCA_REG42" as const : "FLAT_PCT" as const,
      initiationFeePct: Number(body.initiationFeePct ?? 0) / 100,
      initiationFeeMax: Math.round((body.initiationFeeMax ?? 0) * 100),
      monthlyServiceFee: Math.round((body.monthlyServiceFee ?? 0) * 100),
      active: body.active ?? true,
    }
    const contractIssues = micro30ContractIssues(data)
    if (contractIssues.length > 0) {
      return NextResponse.json(
        {
          error: "MICRO30 must use the approved fixed 30-day daily-accrual contract with a 5% monthly rate and R69 service fee.",
          invalidFields: contractIssues,
        },
        { status: 422 },
      )
    }
    const product = await prisma.loanProduct.create({
      data,
    })

    void logAudit({
      tenantId: tenant.id,
      userId: guard.user.id,
      userEmail: guard.user.email,
      action: "LOAN_PRODUCT_CREATED",
      entity: "LoanProduct",
      entityId: product.id,
      newValue: {
        code: product.code, name: product.name, productType: product.productType,
        minAmount: product.minAmount, maxAmount: product.maxAmount,
        minTermDays: product.minTermDays, maxTermDays: product.maxTermDays,
        interestRatePm: product.interestRatePm, interestModel: product.interestModel,
        initiationFeeModel: product.initiationFeeModel,
        initiationFeePct: product.initiationFeePct, initiationFeeMax: product.initiationFeeMax,
        monthlyServiceFee: product.monthlyServiceFee, active: product.active,
      },
    })

    return NextResponse.json(product, { status: 201 })
  })
}
