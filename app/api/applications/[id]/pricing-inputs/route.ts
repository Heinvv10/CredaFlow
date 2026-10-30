import { NextRequest, NextResponse } from "next/server"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { requireApiRole } from "@/lib/auth-guards"
import { canDo } from "@/lib/permissions"
import { PRICING_CHANNELS, isPricingChannel } from "@/lib/product-engine/channels"
import { approvalTermsFor } from "@/lib/product-engine/approval-terms"
import { prisma } from "@/lib/prisma"
import { sastCalendarDate } from "@/lib/date/sast"
import { withTenantContext } from "@/lib/tenant"

type Ctx = { params: Promise<{ id: string }> }

// What the pricing rules are matched on for this application (segment, channel, campaign), and the price they give today.
// Staff set the inputs while the application is still open; approval then prices on them (lib/product-engine/approval-terms.ts).
const OPEN = ["DRAFT", "SUBMITTED", "UNDER_REVIEW"] as const
const label = (v: unknown): v is string | null => v === null || (typeof v === "string" && v.length >= 1 && v.length <= 60 && v === v.trim())

/** The segments the lender's approved pricing rules name: the vocabulary is governed by the rules' maker-checker, not typed at will. */
async function configuredSegments(tenantId: string): Promise<string[]> {
  const rows = await prisma.productPricingRule.findMany({ where: { tenantId, retiredAt: null, segment: { not: null } }, select: { segment: true }, distinct: ["segment"], orderBy: { segment: "asc" } })
  return rows.map((r) => r.segment as string)
}

export async function GET(req: NextRequest, ctx: Ctx) {
  const guard = await requireApiRole("CREDIT_OFFICER")
  if (guard.error) return guard.error
  return withTenantContext(req, async (tenant) => {
    const { id } = await ctx.params
    const application = await prisma.loanApplication.findFirst({ where: { id, tenantId: tenant.id }, include: { product: true, pricingInput: true } })
    if (!application) return NextResponse.json({ error: "Not found" }, { status: 404 })
    const terms = await approvalTermsFor(prisma, tenant.id, { id, productId: application.productId, appliedTermDays: application.appliedTermDays, riskGradeRank: application.riskGradeRank }, application.product, sastCalendarDate(new Date()))
    return NextResponse.json({
      inputs: { segment: application.pricingInput?.segment ?? null, channel: application.pricingInput?.channel ?? null, campaignCode: application.pricingInput?.campaignCode ?? null },
      riskGradeRank: application.riskGradeRank,
      options: { segments: await configuredSegments(tenant.id), channels: PRICING_CHANNELS },
      open: (OPEN as readonly string[]).includes(application.status),
      price: { interestRatePm: terms.interestRatePm, baseRatePm: terms.versioned?.baseRatePm ?? application.product.interestRatePm, productVersion: terms.versioned?.version ?? null, rule: terms.versioned?.pricingRuleName ?? null, repayment: terms.repayment },
    })
  })
}

export async function PUT(req: NextRequest, ctx: Ctx) {
  const guard = await requireApiRole("CREDIT_OFFICER")
  if (guard.error) return guard.error
  if (!canDo(guard.user.role, "set_application_pricing_inputs")) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  return withTenantContext(req, async (tenant) => {
    const { id } = await ctx.params
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null
    const segment = body?.segment ?? null
    const channel = body?.channel ?? null
    const campaignCode = body?.campaignCode ?? null
    if (!body || !label(segment) || !label(channel) || !(campaignCode === null || (typeof campaignCode === "string" && /^[A-Z][A-Z0-9_]{1,39}$/.test(campaignCode)))) {
      return NextResponse.json({ error: "segment is one of the lender's configured segments or null; channel is one of the channels or null; campaignCode is UPPER_SNAKE or null." }, { status: 422 })
    }
    if (channel !== null && !isPricingChannel(channel)) {
      return NextResponse.json({ error: `channel is one of ${PRICING_CHANNELS.join(", ")} or null.` }, { status: 422 })
    }
    if (segment !== null && !(await configuredSegments(tenant.id)).includes(segment)) {
      return NextResponse.json({ error: "segment is not one of the lender's configured segments (the segments its approved pricing rules name)." }, { status: 422 })
    }
    const result = await prisma.$transaction(async (tx) => {
      // The status is read under the row lock the decision also takes, so an approval cannot price on inputs changed after it checked.
      const rows = await tx.$queryRaw<Array<{ status: string }>>`SELECT "status" FROM "LoanApplication" WHERE "id" = ${id} AND "tenantId" = ${tenant.id} FOR UPDATE`
      if (rows.length === 0) return { kind: "not_found" as const }
      if (!(OPEN as readonly string[]).includes(rows[0]!.status)) return { kind: "closed" as const, status: rows[0]!.status }
      const before = await tx.applicationPricingInput.findFirst({ where: { tenantId: tenant.id, applicationId: id } })
      await tx.applicationPricingInput.upsert({
        where: { applicationId: id },
        create: { applicationId: id, tenantId: tenant.id, segment, channel, campaignCode, updatedById: guard.user.id },
        update: { segment, channel, campaignCode, updatedById: guard.user.id },
      })
      await logAuditStrict({
        tenantId: tenant.id, userId: guard.user.id, userEmail: guard.user.email, action: AuditAction.APPLICATION_PRICING_INPUT_SET, entity: "LoanApplication", entityId: id,
        oldValue: before ? { segment: before.segment, channel: before.channel, campaignCode: before.campaignCode } : undefined, newValue: { segment, channel, campaignCode },
      }, tx)
      return { kind: "ok" as const }
    })
    if (result.kind === "not_found") return NextResponse.json({ error: "Not found" }, { status: 404 })
    if (result.kind === "closed") return NextResponse.json({ error: `The application is ${result.status}: its price is already decided.` }, { status: 409 })
    return NextResponse.json({ ok: true })
  })
}
