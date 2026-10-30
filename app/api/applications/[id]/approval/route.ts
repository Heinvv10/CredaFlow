import { NextRequest, NextResponse } from "next/server"
import { requireApiRole } from "@/lib/auth-guards"
import { loadApprovalProgress } from "@/lib/approval/progress"
import { withTenantContext } from "@/lib/tenant"

/** Where the application is in its approval chain, and whether the caller may approve the next level. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireApiRole("CREDIT_OFFICER")
  if (guard.error) return guard.error
  return withTenantContext(req, async (tenant) => {
    const { id } = await params
    return NextResponse.json(await loadApprovalProgress({ tenantId: tenant.id, applicationId: id, viewer: guard.user }))
  })
}
