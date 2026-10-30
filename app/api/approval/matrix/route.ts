import { NextRequest, NextResponse } from "next/server"
import { canDo, requireApiRole } from "@/lib/auth-guards"
import { loadApprovalMatrixOverview } from "@/lib/approval/overview"
import { withTenantContext } from "@/lib/tenant"

/** The matrix in force, the versions before it, and the products and branches a rule can name. Changes go through /api/maker-checker (kind APPROVAL_MATRIX). */
export async function GET(req: NextRequest) {
  const guard = await requireApiRole("LOAN_ADMIN")
  if (guard.error) return guard.error
  if (!canDo(guard.user.role, "view_approval_matrix")) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  return withTenantContext(req, async (tenant) => NextResponse.json(await loadApprovalMatrixOverview(tenant.id, guard.user)))
}
