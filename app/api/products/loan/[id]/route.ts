import { NextRequest, NextResponse } from "next/server"
import { Prisma } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { AuditAction } from "@/lib/audit"
import { loanProductBoundsIssues } from "@/lib/product-config/bounds"
import { loanProductUpdateCapRefusal } from "@/lib/product-config/interest-cap"
import {
  micro30ContractIssues,
  micro30DecisionTermsChanged,
  MICRO30_PROTECTED_APPLICATION_STATUSES,
} from "@/lib/product-config/micro30"
import { nonNcaArrearsAudit, parseNonNcaArrearsTerms } from "@/lib/product-config/non-nca-arrears"

// Codes the client-facing apply pages hardcode; see PRODUCT_KEY_TO_CODE.
/** The LoanProduct columns a product version carries; once a product has a version they change only through one. */
const VERSIONED_PRODUCT_FIELDS = [
  "minAmount", "maxAmount", "minTermDays", "maxTermDays", "interestRatePm", "interestModel", "initiationFeeModel", "initiationFeePct", "initiationFeeMax", "monthlyServiceFee",
] as const

/** Rates arrive from a form as percent x 0.01, so 0.0225 can come back as 0.022500000000000003: compare numbers in basis points. */
const sameValue = (a: unknown, b: unknown) => (typeof a === "number" && typeof b === "number" ? Math.round(a * 10_000) === Math.round(b * 10_000) : a === b)

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

    const arrears = parseNonNcaArrearsTerms(body)
    if ("issues" in arrears) {
      return NextResponse.json(
        {
          error: "The NON_NCA arrears terms must be a default-interest margin as an annual decimal from 0 to below 1 (0.02 = 2%) and a collection fee in whole cents, or null.",
          invalidFields: arrears.issues,
        },
        { status: 422 },
      )
    }
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
      ...arrears.data,
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
      // NCA Regulation 42, on a price change or an activation only (lib/product-config/interest-cap.ts).
      const capRefusal = await loanProductUpdateCapRefusal(tenant.id, before, data)
      if (capRefusal) return { kind: "cap" as const, body: capRefusal }

      // The portal apply pages resolve their product by these exact codes
      // (app/(portal)/portal/apply/[product]/page.tsx PRODUCT_KEY_TO_CODE).
      // Renaming one silently 404s that portal journey with no diagnostic —
      // a hardcoded value coupled to an editable DB value. All three are
      // stable codes.
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
      // Moving a product into or out of ASSET_FINANCE moves it between the
      // asset-finance deal list and every consumer list
      // (lib/product-config/product-kind.ts). A product with applications
      // keeps its kind (they were made under it), and a portal-stable code is
      // always consumer.
      if (data.productType !== undefined && (before.productType === "ASSET_FINANCE") !== (data.productType === "ASSET_FINANCE")) {
        if (PORTAL_STABLE_PRODUCT_CODES.has(beforeCode)) return { kind: "kind_locked" as const, reason: `${beforeCode} is a stable consumer product code` }
        const applications = await tx.loanApplication.count({ where: { tenantId: tenant.id, productId: before.id } })
        if (applications > 0) return { kind: "kind_locked" as const, reason: `${applications} application(s) were made under it` }
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
      // A product under the product engine changes through a version a second person approves (lib/product-engine): its
      // limits, price and fees are no longer edited here. Name, activation and the other fields still are.
      if (await tx.productVersion.count({ where: { tenantId: tenant.id, productId: id } }) > 0) {
        const versioned = VERSIONED_PRODUCT_FIELDS.filter((field) => !sameValue(before[field], data[field]))
        if (versioned.length > 0) return { kind: "versioned" as const, fields: versioned }
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
            ...nonNcaArrearsAudit(before),
          },
          newValue: {
            code: product.code, name: product.name, productType: product.productType,
            minAmount: product.minAmount, maxAmount: product.maxAmount,
            minTermDays: product.minTermDays, maxTermDays: product.maxTermDays,
            interestRatePm: product.interestRatePm, interestModel: product.interestModel,
            initiationFeeModel: product.initiationFeeModel,
            initiationFeePct: product.initiationFeePct, initiationFeeMax: product.initiationFeeMax,
            monthlyServiceFee: product.monthlyServiceFee, active: product.active,
            ...nonNcaArrearsAudit(product),
          },
        },
      })
      return { kind: "updated" as const, product }
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })

    if (result.kind === "not_found") {
      return NextResponse.json({ error: "Not found" }, { status: 404 })
    }
    if (result.kind === "cap") return NextResponse.json(result.body, { status: 422 })
    if (result.kind === "stable_code") {
      return NextResponse.json(
        { error: `${result.code} is a stable product code the portal resolves against and cannot be renamed.` },
        { status: 422 },
      )
    }
    if (result.kind === "kind_locked") {
      return NextResponse.json(
        { error: `The product cannot move into or out of Asset finance: ${result.reason}. Create a new product instead.` },
        { status: 422 },
      )
    }
    if (result.kind === "versioned") {
      return NextResponse.json(
        { error: "This product has versions: its limits, price and fees change by proposing a new version, which a second person approves (Settings, Product versions).", code: "PRODUCT_VERSIONED", fields: result.fields },
        { status: 409 },
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
