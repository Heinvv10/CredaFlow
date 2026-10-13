import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { canDo, requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { sastCalendarDate } from "@/lib/date/sast"
import { requireAssetFinanceEnabled } from "@/lib/asset-finance/require-enabled"
import { parseDealPreview } from "@/lib/asset-finance/deal-input"
import { solveWithRate } from "@/lib/asset-finance/deal-structure"

/**
 * Preview a deal structure (manage_asset_finance). Writes nothing: reads the
 * asset's cash price and the tenant's reference rate, runs the solver and
 * returns the schedule, base instalment and totals. The body is the structure
 * part of a create (lib/asset-finance/deal-input.ts). 422 with the solver's
 * reason when the structure cannot be solved.
 */
export async function POST(req: NextRequest) {
  const guard = await requireApiRole("READONLY")
  if (guard.error) return guard.error

  return withTenantContext(req, async (tenant) => {
    const disabled = await requireAssetFinanceEnabled(tenant.id)
    if (disabled) return disabled
    if (!canDo(guard.user.role, "manage_asset_finance")) {
      return NextResponse.json({ error: "Previewing a deal needs the manage_asset_finance permission" }, { status: 403 })
    }

    const parsed = parseDealPreview(await req.json().catch(() => null), sastCalendarDate(new Date()))
    if ("errors" in parsed) return NextResponse.json({ error: "Invalid structure", fields: parsed.errors }, { status: 400 })

    const asset = await prisma.financedAsset.findFirst({
      where: { id: parsed.data.assetId, tenantId: tenant.id },
      select: { cashPriceExclVatCents: true, vatCents: true },
    })
    if (!asset) return NextResponse.json({ error: "The asset is not on this lender's register" }, { status: 422 })

    const solved = await solveWithRate(prisma, tenant.id, asset, parsed.data.terms)
    if (!solved.ok) return NextResponse.json({ error: solved.error }, { status: 422 })
    return NextResponse.json({
      startDate: solved.startDate,
      termDays: solved.termDays,
      rate: solved.rate,
      weights: parsed.data.terms.weights,
      ...solved.result,
    })
  })
}
