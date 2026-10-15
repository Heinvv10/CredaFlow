import { NextRequest, NextResponse } from "next/server"
import { canDo, requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { requireAssetFinanceEnabled } from "@/lib/asset-finance/require-enabled"
import { getLegalMatterView } from "@/lib/asset-finance/legal-matter-view"
import { openLegalMatter } from "@/lib/asset-finance/legal-matter-store"

export async function POST(req: NextRequest, { params }: { params: Promise<{ loanId: string }> }) {
  const guard = await requireApiRole("READONLY")
  if (guard.error) return guard.error
  return withTenantContext(req, async (tenant) => {
    const disabled = await requireAssetFinanceEnabled(tenant.id)
    if (disabled) return disabled
    if (!canDo(guard.user.role, "manage_asset_finance")) return NextResponse.json({ error: "Opening a legal matter needs manage_asset_finance" }, { status: 403 })
    const { loanId } = await params
    const result = await openLegalMatter({ tenantId: tenant.id, userId: guard.user.id, userEmail: guard.user.email }, loanId)
    if (result.kind === "not_found") return NextResponse.json({ error: "Asset finance loan not found" }, { status: 404 })
    if (result.kind === "not_ready") return NextResponse.json({ error: result.reason }, { status: 409 })
    return NextResponse.json(result, { status: 201 })
  })
}

/** The loan's current legal matter (`matter: null` when it has none). */
export async function GET(req: NextRequest, { params }: { params: Promise<{ loanId: string }> }) {
  const guard = await requireApiRole("READONLY")
  if (guard.error) return guard.error
  return withTenantContext(req, async (tenant) => {
    const disabled = await requireAssetFinanceEnabled(tenant.id)
    if (disabled) return disabled
    const { loanId } = await params
    const result = await getLegalMatterView(tenant.id, { loanId })
    if (result.kind === "not_found") return NextResponse.json({ error: "Asset finance loan not found" }, { status: 404 })
    return NextResponse.json({ matter: result.view })
  })
}
