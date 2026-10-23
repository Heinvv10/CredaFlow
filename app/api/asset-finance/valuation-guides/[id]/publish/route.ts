import { NextRequest, NextResponse } from "next/server"
import { canDo, requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { requireAssetFinanceEnabled } from "@/lib/asset-finance/require-enabled"
import { publishGuide } from "@/lib/valuation-guides/guide-store"
import { guideView } from "@/lib/valuation-guides/guide-view"

/**
 * Publishes a DRAFT valuation guide. Needs manage_valuation_guides, and the
 * publisher must not be its uploader (also CHECK ValuationGuide_four_eyes):
 * 403, audited. It supersedes the current guide of the same name; `superseded`
 * names it. Not a DRAFT, not yet effective, or older than the current guide: 409.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireApiRole("READONLY")
  if (guard.error) return guard.error

  return withTenantContext(req, async (tenant) => {
    const disabled = await requireAssetFinanceEnabled(tenant.id)
    if (disabled) return disabled
    if (!canDo(guard.user.role, "manage_valuation_guides")) {
      return NextResponse.json({ error: "Publishing a valuation guide needs the manage_valuation_guides permission" }, { status: 403 })
    }
    const { id } = await params
    const result = await publishGuide({ tenantId: tenant.id, userId: guard.user.id, userEmail: guard.user.email }, id)
    switch (result.kind) {
      case "not_found":
        return NextResponse.json({ error: "Valuation guide not found" }, { status: 404 })
      case "not_draft":
        return NextResponse.json({ error: `The guide is already ${result.status}` }, { status: 409 })
      case "self_publish":
        return NextResponse.json({ error: "A guide is published by someone other than the person who loaded it" }, { status: 403 })
      case "not_yet_effective":
        return NextResponse.json({ error: `The guide takes effect on ${result.effectiveOn}: publish it from then` }, { status: 409 })
      case "older_than_current":
        return NextResponse.json({ error: `The current guide of this name is effective ${result.currentEffectiveOn}, after this one` }, { status: 409 })
      case "simulation_refused":
        return NextResponse.json({ error: "A simulated guide cannot go live on this deployment" }, { status: 409 })
      case "concurrent_publish":
        return NextResponse.json({ error: "Another guide of this name was published at the same moment: reload and check" }, { status: 409 })
      case "published":
        return NextResponse.json({ ...guideView(result.guide), superseded: result.superseded })
    }
  })
}
