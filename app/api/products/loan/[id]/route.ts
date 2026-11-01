import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { changeRequestErrorResponse, presentChangeRequest } from "@/lib/maker-checker/http"
import { checkProductUpdate, productDeactivateRefusal } from "@/lib/product-config/product-change-rules"
import type { ProductFields } from "@/lib/product-config/product-change"
import { proposeProductChange } from "@/lib/product-config/propose"
import { PENDING_APPROVAL, productFieldsFromBody } from "../product-body"

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireApiRole("READONLY")
  if (guard.error) return guard.error
  return withTenantContext(req, async (tenant) => {
    const { id } = await params
    const product = await prisma.loanProduct.findUnique({ where: { id, tenantId: tenant.id } })
    if (!product) return NextResponse.json({ error: "Not found" }, { status: 404 })
    return NextResponse.json(product)
  })
}

/** Proposes an edit. The product stays as it is until a second person approves the request this answers 202 with (spec 2.1.3). */
export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireApiRole("LOAN_ADMIN")
  if (guard.error) return guard.error
  return withTenantContext(req, async (tenant) => {
    const { id } = await params
    const body = await req.json()
    const parsed = productFieldsFromBody(body)
    if ("response" in parsed) return parsed.response

    const before = await prisma.loanProduct.findUnique({ where: { id, tenantId: tenant.id } })
    if (!before) return NextResponse.json({ error: "Not found" }, { status: 404 })
    const check = await checkProductUpdate(prisma, tenant.id, before, { ...parsed.fields, active: body.active ?? before.active })
    if ("refusal" in check) return NextResponse.json(check.refusal.body, { status: check.refusal.status })

    const changed = (Object.keys(check.data) as Array<keyof ProductFields>).filter((key) => String(check.data[key] ?? "") !== String(before[key] ?? ""))
    try {
      const request = await proposeProductChange(tenant.id, guard.user, `Change ${before.code}: ${changed.join(", ") || "no field"}`, { action: "UPDATE", reason: body.reason, productId: id, product: check.data })
      return NextResponse.json({ status: PENDING_APPROVAL, request: presentChangeRequest(request, guard.user.id, guard.user.role) }, { status: 202 })
    } catch (error) {
      return changeRequestErrorResponse(error)
    }
  })
}

/** Proposes the deactivation of a product, for a second person to approve. */
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireApiRole("LOAN_ADMIN")
  if (guard.error) return guard.error
  return withTenantContext(req, async (tenant) => {
    const { id } = await params
    const body = (await req.json().catch(() => null)) as { reason?: unknown } | null
    const before = await prisma.loanProduct.findUnique({ where: { id, tenantId: tenant.id } })
    if (!before) return NextResponse.json({ error: "Not found" }, { status: 404 })
    const refusal = await productDeactivateRefusal(prisma, tenant.id, before)
    if (refusal) return NextResponse.json(refusal.body, { status: refusal.status })
    try {
      const request = await proposeProductChange(tenant.id, guard.user, `Deactivate ${before.code}`, { action: "DEACTIVATE", reason: typeof body?.reason === "string" ? body.reason : "Product withdrawn from sale", productId: id })
      return NextResponse.json({ status: PENDING_APPROVAL, request: presentChangeRequest(request, guard.user.id, guard.user.role) }, { status: 202 })
    } catch (error) {
      return changeRequestErrorResponse(error)
    }
  })
}
