import { NextRequest, NextResponse } from "next/server"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { requireApiRole } from "@/lib/auth-guards"
import { canDo } from "@/lib/permissions"
import { isNonNcaProductType } from "@/lib/product-config/product-kind"
import { parseProductFacts } from "@/lib/product-types/facts"
import { prisma } from "@/lib/prisma"
import { withTenantContext } from "@/lib/tenant"

type Ctx = { params: Promise<{ id: string }> }

// The facts a salary-backed, SME or group application carries (lib/product-types). Staff set them while it is open; approval reads them.
const OPEN = ["DRAFT", "SUBMITTED", "UNDER_REVIEW"] as const

const view = (f: Awaited<ReturnType<typeof prisma.applicationProductFacts.findFirst>>) => ({
  employerName: f?.employerName ?? null, payrollNumber: f?.payrollNumber ?? null, businessName: f?.businessName ?? null, businessRegistrationNumber: f?.businessRegistrationNumber ?? null,
  annualTurnoverCents: f?.annualTurnoverCents !== null && f?.annualTurnoverCents !== undefined ? Number(f.annualTurnoverCents) : null, borrowerGroupId: f?.borrowerGroupId ?? null,
})

export async function GET(req: NextRequest, ctx: Ctx) {
  const guard = await requireApiRole("CREDIT_OFFICER")
  if (guard.error) return guard.error
  return withTenantContext(req, async (tenant) => {
    const { id } = await ctx.params
    const application = await prisma.loanApplication.findFirst({ where: { id, tenantId: tenant.id }, select: { status: true, product: { select: { productType: true } }, productFacts: true } })
    if (!application) return NextResponse.json({ error: "Not found" }, { status: 404 })
    const groups = application.product.productType === "GROUP" ? await prisma.borrowerGroup.findMany({ where: { tenantId: tenant.id }, orderBy: { name: "asc" }, select: { id: true, name: true } }) : []
    return NextResponse.json({ productType: application.product.productType, facts: view(application.productFacts), groups, open: (OPEN as readonly string[]).includes(application.status) })
  })
}

export async function PUT(req: NextRequest, ctx: Ctx) {
  const guard = await requireApiRole("CREDIT_OFFICER")
  if (guard.error) return guard.error
  if (!canDo(guard.user.role, "set_application_pricing_inputs")) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  return withTenantContext(req, async (tenant) => {
    const { id } = await ctx.params
    const body = await req.json().catch(() => null)
    const product = await prisma.loanApplication.findFirst({ where: { id, tenantId: tenant.id }, select: { product: { select: { productType: true } } } })
    if (!product) return NextResponse.json({ error: "Not found" }, { status: 404 })
    const type = product.product.productType
    if (!isNonNcaProductType(type)) return NextResponse.json({ error: "This application's product type carries no such facts." }, { status: 422 })
    const parsed = parseProductFacts(type, body)
    if ("problems" in parsed) return NextResponse.json({ error: parsed.problems.join("; "), problems: parsed.problems }, { status: 422 })
    const facts = parsed.facts
    if (facts.borrowerGroupId && !(await prisma.borrowerGroup.findFirst({ where: { id: facts.borrowerGroupId, tenantId: tenant.id }, select: { id: true } }))) {
      return NextResponse.json({ error: "That lending group does not exist." }, { status: 422 })
    }
    const result = await prisma.$transaction(async (tx) => {
      // The status is read under the row lock the decision also takes, so an approval cannot read facts changed after it checked.
      const rows = await tx.$queryRaw<Array<{ status: string }>>`SELECT "status" FROM "LoanApplication" WHERE "id" = ${id} AND "tenantId" = ${tenant.id} FOR UPDATE`
      if (!(OPEN as readonly string[]).includes(rows[0]?.status ?? "")) return { closed: rows[0]?.status ?? "closed" }
      // As the pricing inputs: whoever sets these is input staff of the application and does not approve it.
      await tx.loanApplication.updateMany({ where: { id, tenantId: tenant.id, NOT: { inputStaffIds: { has: guard.user.id } } }, data: { inputStaffIds: { push: guard.user.id } } })
      const before = await tx.applicationProductFacts.findFirst({ where: { tenantId: tenant.id, applicationId: id } })
      await tx.applicationProductFacts.upsert({
        where: { applicationId: id },
        create: { applicationId: id, tenantId: tenant.id, ...facts, updatedById: guard.user.id },
        update: { ...facts, updatedById: guard.user.id },
      })
      await logAuditStrict({
        tenantId: tenant.id, userId: guard.user.id, userEmail: guard.user.email, action: AuditAction.APPLICATION_PRODUCT_FACTS_SET, entity: "LoanApplication", entityId: id,
        oldValue: before ? view(before) : undefined, newValue: { ...facts, annualTurnoverCents: facts.annualTurnoverCents === null ? null : Number(facts.annualTurnoverCents) },
      }, tx)
      return { closed: null }
    })
    if (result.closed) return NextResponse.json({ error: `The application is ${result.closed}: its facts are already decided.` }, { status: 409 })
    return NextResponse.json({ ok: true })
  })
}
