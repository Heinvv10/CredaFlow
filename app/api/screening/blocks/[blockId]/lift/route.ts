import { NextRequest, NextResponse } from "next/server"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { demoStaffWithoutTotp } from "@/lib/config/demo-mode"
import { callerIp } from "@/lib/rate-limit"
import { liftScreeningBlock } from "@/lib/screening/blocks"
import { screeningStateMessage } from "@/lib/screening/state"

/**
 * POST /api/screening/blocks/[blockId]/lift — { reason }. SUPER_ADMIN with a
 * TOTP-verified session; audited; once (lib/screening/blocks.ts, and the
 * trigger guardScreeningBlock).
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ blockId: string }> }) {
  const guard = await requireApiRole("SUPER_ADMIN")
  if (guard.error) return guard.error
  const totpVerified = guard.user.totpVerified === true

  return withTenantContext(req, async (tenant) => {
    const { blockId } = await ctx.params
    const body = (await req.json().catch(() => null)) as { reason?: unknown } | null
    if (typeof body?.reason !== "string" || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(body.reason)) {
      return NextResponse.json({ error: "Send the reason for lifting the block." }, { status: 400 })
    }
    const outcome = await liftScreeningBlock({
      tenantId: tenant.id,
      blockId,
      reason: body.reason,
      actor: { id: guard.user.id, email: guard.user.email, role: guard.user.role, totpVerified },
      totpWaived: !totpVerified && demoStaffWithoutTotp(),
      ipAddress: callerIp(req),
    })
    if (!outcome.ok) return NextResponse.json({ error: outcome.error }, { status: outcome.status })
    return NextResponse.json({ ok: true, state: outcome.state, message: screeningStateMessage(outcome.state) })
  })
}
