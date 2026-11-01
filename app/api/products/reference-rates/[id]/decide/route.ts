import { NextRequest, NextResponse } from "next/server"
import { referenceRateView } from "@/app/api/asset-finance/reference-rates/view"
import { decideReferenceRate } from "@/lib/asset-finance/reference-rate-decision"
import { requireApiRole } from "@/lib/auth-guards"
import { sastCalendarDate } from "@/lib/date/sast"
import { isNcaJurisdiction } from "@/lib/jurisdiction/active"
import { ensureActiveJurisdiction } from "@/lib/jurisdiction/load.server"
import { canDo } from "@/lib/permissions"
import { VARIABLE_RATE_BASES } from "@/lib/product-engine/types"
import { prisma } from "@/lib/prisma"
import { withTenantContext } from "@/lib/tenant"

/** A second person's decision on a PENDING value: { decision: "APPROVE" | "REJECT" }. CHECK ReferenceRate_four_eyes holds the rule as well. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireApiRole("LOAN_ADMIN")
  if (guard.error) return guard.error
  await ensureActiveJurisdiction()
  if (isNcaJurisdiction()) return NextResponse.json({ error: "Reference rates do not apply here." }, { status: 404 })
  if (!canDo(guard.user.role, "approve_product_versions")) return NextResponse.json({ error: "Deciding a reference rate needs the approve_product_versions permission" }, { status: 403 })
  return withTenantContext(req, async (tenant) => {
    const { id } = await params
    const body = (await req.json().catch(() => null)) as { decision?: unknown } | null
    if (body?.decision !== "APPROVE" && body?.decision !== "REJECT") return NextResponse.json({ error: "decision must be APPROVE or REJECT" }, { status: 400 })
    const target = await prisma.referenceRate.findFirst({ where: { id, tenantId: tenant.id }, select: { basis: true } })
    if (!target || !(VARIABLE_RATE_BASES as readonly string[]).includes(target.basis)) return NextResponse.json({ error: "Reference rate not found" }, { status: 404 })
    const decision = body.decision
    const result = await prisma.$transaction((tx) => decideReferenceRate(tx, { tenantId: tenant.id, rateId: id, decision, deciderId: guard.user.id, deciderEmail: guard.user.email, today: sastCalendarDate(new Date()), skipReach: true }))
    if (result.kind === "not_found") return NextResponse.json({ error: "Reference rate not found" }, { status: 404 })
    if (result.kind === "not_pending") return NextResponse.json({ error: `The reference rate is already ${result.status}` }, { status: 409 })
    if (result.kind === "self_decision") return NextResponse.json({ error: "A reference rate must be decided by someone other than the user who recorded it" }, { status: 403 })
    return NextResponse.json(referenceRateView(result.rate))
  })
}
