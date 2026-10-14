import { NextRequest, NextResponse } from "next/server"
import { canDo, requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { requireAssetFinanceEnabled } from "@/lib/asset-finance/require-enabled"
import { requestSurrender } from "@/lib/asset-finance/surrender-store"

export async function POST(req: NextRequest, { params }: { params: Promise<{ loanId: string }> }) {
  const guard = await requireApiRole("READONLY")
  if (guard.error) return guard.error
  return withTenantContext(req, async (tenant) => {
    const disabled = await requireAssetFinanceEnabled(tenant.id)
    if (disabled) return disabled
    if (!canDo(guard.user.role, "manage_asset_finance")) return NextResponse.json({ error: "Recording a surrender needs manage_asset_finance" }, { status: 403 })
    const body = await req.json().catch(() => null) as { assetCondition?: unknown } | null
    const { loanId } = await params
    const result = await requestSurrender({ tenantId: tenant.id, userId: guard.user.id, userEmail: guard.user.email }, loanId, typeof body?.assetCondition === "string" ? body.assetCondition : "", "STAFF")
    if (result.kind === "not_found") return NextResponse.json({ error: "Eligible loan not found" }, { status: 404 })
    if (result.kind === "not_ready") return NextResponse.json({ error: result.reason }, { status: 422 })
    return NextResponse.json(result, { status: 201 })
  })
}
