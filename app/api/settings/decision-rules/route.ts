import { NextRequest, NextResponse } from "next/server"
import { requireApiRole } from "@/lib/auth-guards"
import { loadDecisioningOverview } from "@/lib/decisioning/overview"
import { canDo } from "@/lib/permissions"
import { withTenantContext } from "@/lib/tenant"

/** Rule set versions, engine settings, pending changes and run statistics for the settings page. */
export async function GET(req: NextRequest) {
  const guard = await requireApiRole("LOAN_ADMIN")
  if (guard.error) return guard.error
  if (!canDo(guard.user.role, "view_decision_rules")) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  return withTenantContext(req, async (tenant) => {
    const overview = await loadDecisioningOverview(tenant.id, guard.user)
    return NextResponse.json({
      ...overview,
      canManage: canDo(guard.user.role, "manage_decision_rules"),
      canApprove: canDo(guard.user.role, "approve_decision_rules"),
    })
  })
}
