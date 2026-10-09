import { NextRequest, NextResponse } from "next/server"
import { Prisma } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { AuditAction } from "@/lib/audit"
import {
  micro30ContractIssues,
  micro30DecisionTermsChanged,
  MICRO30_PROTECTED_APPLICATION_STATUSES,
} from "@/lib/product-config/micro30"

// Codes the client-facing apply pages hardcode; see PRODUCT_KEY_TO_CODE.
const PORTAL_STABLE_PRODUCT_CODES = new Set(["MICRO30", "PERSONAL", "POFUND"])

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

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireApiRole("ADMIN")
  if (guard.error) return guard.error
  return withTenantContext(req, async (tenant) => {
    const { id } = await params
    const body = await req.json()

    const data = {
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
      active: body.active,
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
    const result = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw(Prisma.sql`
        SELECT "id"
        FROM "LoanProduct"
        WHERE "id" = ${id}
          AND "tenantId" = ${tenant.id}
        FOR UPDATE
      `)
      const before = await tx.loanProduct.findUnique({
        where: { id, tenantId: tenant.id },
      })
      if (!before) return { kind: "not_found" as const }

      // The portal apply pages resolve their product by these exact codes
      // (app/(portal)/portal/apply/[product]/page.tsx PRODUCT_KEY_TO_CODE).
      // Renaming one silently 404s that portal journey with no diagnostic —
      // the same hardcoded-value-vs-editable-DB failure shape as past
      // incidents. All three are stable codes.
      const beforeCode = before.code.trim().toUpperCase()
      if (PORTAL_STABLE_PRODUCT_CODES.has(beforeCode)) {
        if (String(data.code).trim().toUpperCase() !== beforeCode) {
          return { kind: "stable_code" as const, code: beforeCode }
        }
        // The comparison is normalised but the WRITE was not: " micro30 "
        // passed the guard yet stored a string the portal's exact-match
        // lookup no longer finds. A stable code has exactly one permitted
        // value — pin the write to it.
        data.code = beforeCode
      }
      if (
        before.code.trim().toUpperCase() === "MICRO30"
        && micro30DecisionTermsChanged(before, data)
      ) {
        const inFlight = await tx.loanApplication.count({
          where: {
            tenantId: tenant.id,
            productId: before.id,
            status: { in: [...MICRO30_PROTECTED_APPLICATION_STATUSES] },
          },
        })
        if (inFlight > 0) {
          return { kind: "in_flight" as const, inFlight }
        }
      }
      const product = await tx.loanProduct.update({
        where: { id, tenantId: tenant.id },
        data,
      })
      await tx.auditLog.create({
        data: {
          tenantId: tenant.id,
          userId: guard.user.id,
          userEmail: guard.user.email,
          action: AuditAction.LOAN_PRODUCT_UPDATED,
          entity: "LoanProduct",
          entityId: id,
          oldValue: {
            code: before.code, name: before.name, productType: before.productType,
            minAmount: before.minAmount, maxAmount: before.maxAmount,
            minTermDays: before.minTermDays, maxTermDays: before.maxTermDays,
            interestRatePm: before.interestRatePm, interestModel: before.interestModel,
            initiationFeeModel: before.initiationFeeModel,
            initiationFeePct: before.initiationFeePct, initiationFeeMax: before.initiationFeeMax,
            monthlyServiceFee: before.monthlyServiceFee, active: before.active,
          },
          newValue: {
            code: product.code, name: product.name, productType: product.productType,
            minAmount: product.minAmount, maxAmount: product.maxAmount,
            minTermDays: product.minTermDays, maxTermDays: product.maxTermDays,
            interestRatePm: product.interestRatePm, interestModel: product.interestModel,
            initiationFeeModel: product.initiationFeeModel,
            initiationFeePct: product.initiationFeePct, initiationFeeMax: product.initiationFeeMax,
            monthlyServiceFee: product.monthlyServiceFee, active: product.active,
          },
        },
      })
      return { kind: "updated" as const, product }
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })

    if (result.kind === "not_found") {
      return NextResponse.json({ error: "Not found" }, { status: 404 })
    }
    if (result.kind === "stable_code") {
      return NextResponse.json(
        { error: `${result.code} is a stable product code the portal resolves against and cannot be renamed.` },
        { status: 422 },
      )
    }
    if (result.kind === "in_flight") {
        return NextResponse.json(
          {
            error: "MICRO30 pricing cannot change while an open application may depend on the current quote, decision, PASQ, agreement, or signature evidence.",
            inFlightApplications: result.inFlight,
          },
          { status: 409 },
        )
    }
    return NextResponse.json(result.product)
  })
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireApiRole("ADMIN")
  if (guard.error) return guard.error
  return withTenantContext(req, async (tenant) => {
    const { id } = await params

    const result = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw(Prisma.sql`
        SELECT "id"
        FROM "LoanProduct"
        WHERE "id" = ${id}
          AND "tenantId" = ${tenant.id}
        FOR UPDATE
      `)
      const before = await tx.loanProduct.findUnique({
        where: { id, tenantId: tenant.id },
      })
      if (!before) return { kind: "not_found" as const }

      if (before.code.trim().toUpperCase() === "MICRO30") {
        const inFlight = await tx.loanApplication.count({
          where: {
            tenantId: tenant.id,
            productId: before.id,
            status: { in: [...MICRO30_PROTECTED_APPLICATION_STATUSES] },
          },
        })
        if (inFlight > 0) {
          return { kind: "in_flight" as const, inFlight }
        }
      }

      await tx.loanProduct.update({
        where: { id, tenantId: tenant.id },
        data: { active: false },
      })
      await tx.auditLog.create({
        data: {
          tenantId: tenant.id,
          userId: guard.user.id,
          userEmail: guard.user.email,
          action: AuditAction.LOAN_PRODUCT_DEACTIVATED,
          entity: "LoanProduct",
          entityId: id,
          oldValue: { active: before.active },
          newValue: { active: false },
        },
      })
      return { kind: "deactivated" as const }
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })

    if (result.kind === "not_found") {
      return NextResponse.json({ error: "Not found" }, { status: 404 })
    }
    if (result.kind === "in_flight") {
      return NextResponse.json(
        {
          error: "MICRO30 cannot be deactivated while an open application may depend on the current quote, decision, agreement, or signature evidence.",
          inFlightApplications: result.inFlight,
        },
        { status: 409 },
      )
    }

    return NextResponse.json({ success: true })
  })
}
