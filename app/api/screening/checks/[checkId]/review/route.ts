import { NextRequest, NextResponse } from "next/server"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { demoStaffWithoutTotp } from "@/lib/config/demo-mode"
import { callerIp } from "@/lib/rate-limit"
import { isScreeningDecision, reviewScreeningCheck } from "@/lib/screening/review"
import { screeningStateMessage } from "@/lib/screening/state"

/**
 * POST /api/screening/checks/[checkId]/review — decide one screening match:
 * { decision: "FALSE_POSITIVE" | "ACCEPTED" | "REJECTED", reason }.
 *
 * BRANCH_MANAGER is the floor (the lowest per-lender minimum); the lender's
 * own minimum (TenantConfig.screeningReviewMinRole) and its staff-2FA policy
 * are applied inside the transaction by reviewScreeningCheck. A confirmed
 * sanctions match is refused whoever asks.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ checkId: string }> }) {
  const guard = await requireApiRole("BRANCH_MANAGER")
  if (guard.error) return guard.error
  const totpVerified = guard.user.totpVerified === true

  return withTenantContext(req, async (tenant) => {
    const { checkId } = await ctx.params
    const body = (await req.json().catch(() => null)) as { decision?: unknown; reason?: unknown } | null
    if (!body || !isScreeningDecision(body.decision) || typeof body.reason !== "string") {
      return NextResponse.json(
        { error: "Send a decision (FALSE_POSITIVE, ACCEPTED or REJECTED) and a reason." },
        { status: 400 },
      )
    }
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(body.reason)) {
      return NextResponse.json({ error: "The reason contains control characters." }, { status: 400 })
    }
    const outcome = await reviewScreeningCheck({
      tenantId: tenant.id,
      checkId,
      decision: body.decision,
      reason: body.reason,
      actor: { id: guard.user.id, email: guard.user.email, role: guard.user.role, totpVerified },
      totpWaived: !totpVerified && demoStaffWithoutTotp(),
      ipAddress: callerIp(req),
    })
    if (!outcome.ok) {
      return NextResponse.json({ error: outcome.error, code: outcome.code }, { status: outcome.status })
    }
    return NextResponse.json({ ok: true, state: outcome.state, message: screeningStateMessage(outcome.state) })
  })
}
