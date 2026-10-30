import { NextRequest, NextResponse } from "next/server"
import { requireApiRole } from "@/lib/auth-guards"
import { HumanReviewError, requestHumanReview } from "@/lib/decisioning/human-review"
import { withTenantContext } from "@/lib/tenant"

/** Reopens an automatically declined application for a person to decide: { reason }. LOAN_ADMIN and above, as a decline is. */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const guard = await requireApiRole("LOAN_ADMIN")
  if (guard.error) return guard.error
  return withTenantContext(req, async (tenant) => {
    const { id } = await ctx.params
    const body = (await req.json().catch(() => null)) as { reason?: unknown } | null
    if (!body || typeof body.reason !== "string") return NextResponse.json({ error: "Expected { reason }" }, { status: 400 })
    try {
      await requestHumanReview({ tenantId: tenant.id, applicationId: id, actor: guard.user, reason: body.reason })
      return NextResponse.json({ ok: true, status: "UNDER_REVIEW" })
    } catch (error) {
      if (error instanceof HumanReviewError) return NextResponse.json({ error: error.message, code: error.code }, { status: error.status })
      throw error
    }
  })
}
