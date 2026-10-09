import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { REFERRAL_REASSIGN_MIN_ROLE } from "@/lib/clients/referral-update"
import { loadRetroAttributionPlan } from "@/lib/referral-agents/retro-attribution-apply"
import { serialiseRetroPlan } from "@/lib/referral-agents/retro-attribution"

/**
 * What re-pointing this client's referral agent to `codeId` would do to the
 * commission ledger. Read-only; the PUT derives its write from the SAME planner,
 * so the confirmation an operator signs off on cannot disagree with what lands.
 *
 * Carries the reassignment floor rather than a read floor: the preview discloses
 * another agent's commission and is the first half of the same act.
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const guard = await requireApiRole(REFERRAL_REASSIGN_MIN_ROLE)
  if (guard.error) return guard.error
  const { id } = await ctx.params

  return withTenantContext(req, async (tenant) => {
    // The code on FILE, not one the caller asserts — a stale form must not be
    // shown a reversal that will not happen.
    const client = await prisma.client.findUnique({
      where: { id, tenantId: tenant.id },
      select: { referralCodeId: true },
    })
    if (!client) return NextResponse.json({ error: "Client not found" }, { status: 404 })

    const plan = await loadRetroAttributionPlan(prisma, {
      tenantId: tenant.id,
      clientId: id,
      incomingCodeId: req.nextUrl.searchParams.get("codeId")?.trim() || null,
      previousCodeId: client.referralCodeId,
    })

    return NextResponse.json(serialiseRetroPlan(plan))
  })
}
