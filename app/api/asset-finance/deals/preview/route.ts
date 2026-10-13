import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { canDo, requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { sastCalendarDate } from "@/lib/date/sast"
import { requireAssetFinanceEnabled } from "@/lib/asset-finance/require-enabled"
import { parseDealPreview } from "@/lib/asset-finance/deal-input"
import { solveWithRate } from "@/lib/asset-finance/deal-structure"
import { NCA_ASSET_CAPS, resolvedAssetFinanceNcaCapProblems } from "@/lib/asset-finance/nca-caps"

/**
 * Preview a deal structure (manage_asset_finance). Writes nothing: reads the
 * asset's cash price and the tenant's reference rate, runs the solver and
 * returns the schedule, base instalment and totals. The body is the structure
 * part of a create (lib/asset-finance/deal-input.ts). A structure that cannot
 * be solved is an answer about the input, not a failed request: 200 with
 * `{ error }` (the solver's reason) and no schedule. 400 for malformed fields,
 * 422 when the asset is not on the register.
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
    if (!solved.ok) return NextResponse.json({ error: solved.error })
    if (parsed.data.nca) {
      const problems = await resolvedAssetFinanceNcaCapProblems(prisma, tenant.id, solved.startDate, {
        contractType: parsed.data.contractType,
        annualRate: Number(solved.rate.annualRate),
        principalCents: solved.result.financedAmountCents,
        initiationFeeCents: parsed.data.terms.financedFeesCents,
        monthlyServiceFeeCents: NCA_ASSET_CAPS.monthlyServiceFeeCents,
      })
      if (problems === null) return NextResponse.json({ error: "No approved REPO rate exists for the NCA cap on the deal start date" })
      if (problems.length > 0) return NextResponse.json({ error: problems[0].message })
    }
    return NextResponse.json({
      startDate: solved.startDate,
      termDays: solved.termDays,
      rate: solved.rate,
      weights: parsed.data.terms.weights,
      ...solved.result,
    })
  })
}
