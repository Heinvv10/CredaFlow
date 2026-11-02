import { NextRequest, NextResponse } from "next/server"
import { requireApiRole } from "@/lib/auth-guards"
import { loadLoanChangesView } from "@/lib/loan-changes/view"
import { withTenantContext } from "@/lib/tenant"

/**
 * A loan's changes: whether it can be changed, the proposals on it and what was applied, with the schedules each replaced.
 * Proposing and deciding go through /api/maker-checker (kind LOAN_CHANGE).
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const guard = await requireApiRole("READONLY")
  if (guard.error) return guard.error
  return withTenantContext(req, async (tenant) => {
    const { id } = await ctx.params
    const view = await loadLoanChangesView(tenant.id, id, guard.user)
    if (!view) return NextResponse.json({ error: "Loan not found" }, { status: 404 })
    return NextResponse.json(view)
  })
}
