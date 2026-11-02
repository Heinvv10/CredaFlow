import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { changeRequestErrorResponse, presentChangeRequest } from "@/lib/maker-checker/http"
import { productCreateRefusal } from "@/lib/product-config/product-change-rules"
import { proposeProductChange } from "@/lib/product-config/propose"
import { PENDING_APPROVAL, productFieldsFromBody } from "./product-body"

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

/** Proposes a new product. Nothing is created until a second person approves the request this answers 202 with (spec 2.1.3). */
export async function POST(req: NextRequest) {
  const guard = await requireApiRole("LOAN_ADMIN")
  if (guard.error) return guard.error
  return withTenantContext(req, async (tenant) => {
    const body = await req.json()
    const parsed = productFieldsFromBody(body)
    if ("response" in parsed) return parsed.response
    const product = { ...parsed.fields, active: body.active ?? true }
    const refusal = await productCreateRefusal(prisma, tenant.id, product)
    if (refusal) return NextResponse.json(refusal.body, { status: refusal.status })
    try {
      const request = await proposeProductChange(tenant.id, guard.user, `New loan product: ${product.code}`, { action: "CREATE", reason: body.reason, product })
      return NextResponse.json({ status: PENDING_APPROVAL, request: presentChangeRequest(request, guard.user.id, guard.user.role) }, { status: 202 })
    } catch (error) {
      return changeRequestErrorResponse(error)
    }
  })
}
