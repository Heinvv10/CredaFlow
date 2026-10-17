import { NextRequest, NextResponse } from "next/server"
import { canDo, requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { requireAssetFinanceEnabled } from "@/lib/asset-finance/require-enabled"
import { approveSurplusAccount, recordSurplusAccount } from "@/lib/asset-finance/nca-surplus-account"
import { parseRefundForm } from "@/lib/asset-finance/recovery-refund-input"
export async function POST(req: NextRequest, { params }: { params: Promise<{ loanId: string; action: string }> }) {
  const guard = await requireApiRole("READONLY")
  if (guard.error) return guard.error
  return withTenantContext(req, async (tenant) => {
    const disabled = await requireAssetFinanceEnabled(tenant.id)
    if (disabled) return disabled
    const { loanId, action } = await params
    if (!["record", "approve", "authorise"].includes(action)) return NextResponse.json({ error: "Unknown account action" }, { status: 404 })
    const permission = action === "record" ? "manage_asset_finance" : "decide_asset_finance"
    if (!canDo(guard.user.role, permission)) return NextResponse.json({ error: "Surplus bank verification requires authorised staff" }, { status: 403 })
    const actor = { tenantId: tenant.id, userId: guard.user.id, userEmail: guard.user.email }
    let result
    if (action === "record") {
      const parsed = await parseRefundForm(req)
      if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 })
      result = await recordSurplusAccount(actor, loanId, parsed)
    } else result = await approveSurplusAccount(actor, loanId, action as "approve" | "authorise")
    if (result.kind === "not_found") return NextResponse.json({ error: "NCA loan or bank record not found" }, { status: 404 })
    if (result.kind === "not_ready") return NextResponse.json({ error: result.reason }, { status: 409 })
    return NextResponse.json(result)
  })
}
