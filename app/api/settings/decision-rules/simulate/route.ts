import { NextRequest, NextResponse } from "next/server"
import { requireApiRole } from "@/lib/auth-guards"
import { simulateRuleSet } from "@/lib/decisioning/simulate"
import { parseSimulationWindow } from "@/lib/decisioning/simulate-window"
import { ChangeRequestError } from "@/lib/maker-checker/errors"
import { changeRequestErrorResponse } from "@/lib/maker-checker/http"
import { canDo } from "@/lib/permissions"
import { prisma } from "@/lib/prisma"
import { withTenantContext } from "@/lib/tenant"

/**
 * Replays a draft ({ draft: { productId, rules, scorecard } }) or an approved
 * version ({ versionId }) over recent applications. Read-only.
 */
export async function POST(req: NextRequest) {
  const guard = await requireApiRole("LOAN_ADMIN")
  if (guard.error) return guard.error
  if (!canDo(guard.user.role, "manage_decision_rules")) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  return withTenantContext(req, async (tenant) => {
    const body = (await req.json().catch(() => null)) as { versionId?: unknown; draft?: { productId?: unknown; rules?: unknown; scorecard?: unknown }; limit?: unknown; sinceDays?: unknown } | null
    if (!body) return NextResponse.json({ error: "Expected a JSON body" }, { status: 400 })
    const window = parseSimulationWindow(body)
    if (!window.ok) return NextResponse.json({ error: window.error }, { status: 400 })
    try {
      let candidate: { rules: unknown; scorecard: unknown; productId: string | null }
      if (typeof body.versionId === "string") {
        const version = await prisma.decisionRuleSetVersion.findFirst({ where: { id: body.versionId, tenantId: tenant.id } })
        if (!version) throw new ChangeRequestError("NOT_FOUND", "Rule set version not found")
        candidate = { rules: version.rules, scorecard: version.scorecard, productId: version.productId }
      } else if (body.draft) {
        candidate = { rules: body.draft.rules, scorecard: body.draft.scorecard ?? null, productId: typeof body.draft.productId === "string" ? body.draft.productId : null }
      } else {
        return NextResponse.json({ error: "Give a versionId or a draft" }, { status: 400 })
      }
      const report = await simulateRuleSet({
        tenantId: tenant.id, candidate,
        limit: window.limit,
        sinceDays: window.sinceDays,
      })
      return NextResponse.json({ report })
    } catch (error) {
      return changeRequestErrorResponse(error)
    }
  })
}
