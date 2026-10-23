import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { canDo, requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { sastCalendarDate } from "@/lib/date/sast"
import { requireAssetFinanceEnabled } from "@/lib/asset-finance/require-enabled"
import { guideCandidates, recordGuideValuation } from "@/lib/valuation-guides/lookup"

type Params = { params: Promise<{ id: string }> }

/** The current guides' rows for the asset's make, model and year (docs/asset-finance/SLICE5.md part C). */
export async function GET(req: NextRequest, { params }: Params) {
  const guard = await requireApiRole("READONLY")
  if (guard.error) return guard.error

  return withTenantContext(req, async (tenant) => {
    const disabled = await requireAssetFinanceEnabled(tenant.id)
    if (disabled) return disabled
    const { id } = await params
    const asset = await prisma.financedAsset.findFirst({ where: { id, tenantId: tenant.id }, select: { make: true, model: true, year: true } })
    if (!asset) return NextResponse.json({ error: "Asset not found" }, { status: 404 })
    return NextResponse.json({ candidates: await guideCandidates(prisma, tenant.id, asset, sastCalendarDate(new Date())) })
  })
}

/**
 * Records `{ guideRowId }`, one of the asset's current guide rows, as its GUIDE
 * valuation: dated today at the row's trade value, the row snapshotted by the
 * database. A reference value: it never counts as an independent valuation.
 * Needs manage_asset_finance; a row that is not a current candidate for this
 * asset (another lender's included) is 404.
 */
export async function POST(req: NextRequest, { params }: Params) {
  const guard = await requireApiRole("READONLY")
  if (guard.error) return guard.error

  return withTenantContext(req, async (tenant) => {
    const disabled = await requireAssetFinanceEnabled(tenant.id)
    if (disabled) return disabled
    if (!canDo(guard.user.role, "manage_asset_finance")) {
      return NextResponse.json({ error: "Recording a valuation needs the manage_asset_finance permission" }, { status: 403 })
    }
    const { id } = await params
    const body = await req.json().catch(() => null) as { guideRowId?: unknown } | null
    if (typeof body?.guideRowId !== "string" || body.guideRowId.length === 0 || body.guideRowId.length > 64) {
      return NextResponse.json({ error: "Invalid guide valuation", fields: { guideRowId: "is required" } }, { status: 400 })
    }
    const result = await recordGuideValuation({ tenantId: tenant.id, userId: guard.user.id, userEmail: guard.user.email }, id, body.guideRowId)
    switch (result.kind) {
      case "not_found":
        return NextResponse.json({ error: result.what === "asset" ? "Asset not found" : "Not a current guide row for this asset" }, { status: 404 })
      case "day_changed":
        return NextResponse.json({ error: "The day changed while the guide value was being recorded: record it again" }, { status: 409 })
      case "simulation_refused":
        return NextResponse.json({ error: "A simulated guide's value cannot be recorded on this deployment" }, { status: 409 })
      case "recorded":
        return NextResponse.json(result.valuation, { status: 201 })
    }
  })
}
