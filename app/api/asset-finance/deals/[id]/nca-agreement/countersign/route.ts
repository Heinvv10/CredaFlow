import { NextRequest, NextResponse } from "next/server"
import { canDo, requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { requireAssetFinanceEnabled } from "@/lib/asset-finance/require-enabled"
import { countersignAssetNcaAgreement } from "@/lib/asset-finance/nca-agreement-store"

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireApiRole("READONLY")
  if (guard.error) return guard.error
  return withTenantContext(req, async (tenant) => {
    const disabled = await requireAssetFinanceEnabled(tenant.id)
    if (disabled) return disabled
    if (!canDo(guard.user.role, "manage_asset_finance")) return NextResponse.json({ error: "Countersigning needs manage_asset_finance" }, { status: 403 })
    const body = await req.json().catch(() => null) as { signature?: unknown } | null
    const signature = typeof body?.signature === "string" ? body.signature.trim() : ""
    if (signature.length < 3 || signature.length > 120) return NextResponse.json({ error: "Type the provider countersignatory's full name" }, { status: 422 })
    const { id } = await params
    const result = await countersignAssetNcaAgreement({ tenantId: tenant.id, userId: guard.user.id, userEmail: guard.user.email }, id, signature)
    if (result.kind === "not_found") return NextResponse.json({ error: "Deal not found" }, { status: 404 })
    if (result.kind === "not_ready") return NextResponse.json({ error: result.reason }, { status: 409 })
    return NextResponse.json(result)
  })
}
