import { NextRequest, NextResponse } from "next/server"
import { canDo, requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { requireAssetFinanceEnabled } from "@/lib/asset-finance/require-enabled"
import { discardGuide } from "@/lib/valuation-guides/guide-store"
import { guideView } from "@/lib/valuation-guides/guide-view"

/** Discards a DRAFT valuation guide: any guide manager may, its uploader included. Needs manage_valuation_guides; not a DRAFT is 409. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireApiRole("READONLY")
  if (guard.error) return guard.error

  return withTenantContext(req, async (tenant) => {
    const disabled = await requireAssetFinanceEnabled(tenant.id)
    if (disabled) return disabled
    if (!canDo(guard.user.role, "manage_valuation_guides")) {
      return NextResponse.json({ error: "Discarding a valuation guide needs the manage_valuation_guides permission" }, { status: 403 })
    }
    const { id } = await params
    const result = await discardGuide({ tenantId: tenant.id, userId: guard.user.id, userEmail: guard.user.email }, id)
    switch (result.kind) {
      case "not_found":
        return NextResponse.json({ error: "Valuation guide not found" }, { status: 404 })
      case "not_draft":
        return NextResponse.json({ error: `The guide is already ${result.status}` }, { status: 409 })
      case "discarded":
        return NextResponse.json(guideView(result.guide))
    }
  })
}
