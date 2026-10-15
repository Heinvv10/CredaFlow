import { NextRequest, NextResponse } from "next/server"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { requireAssetFinanceEnabled } from "@/lib/asset-finance/require-enabled"
import { getLegalMatterView } from "@/lib/asset-finance/legal-matter-view"

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireApiRole("READONLY")
  if (guard.error) return guard.error
  return withTenantContext(req, async (tenant) => {
    const disabled = await requireAssetFinanceEnabled(tenant.id)
    if (disabled) return disabled
    const { id } = await params
    const result = await getLegalMatterView(tenant.id, { matterId: id })
    if (result.kind === "not_found" || !result.view) return NextResponse.json({ error: "Legal matter not found" }, { status: 404 })
    return NextResponse.json({ matter: result.view })
  })
}
