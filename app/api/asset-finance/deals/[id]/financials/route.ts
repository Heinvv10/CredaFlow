import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { canDo, requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { sastCalendarDate } from "@/lib/date/sast"
import { isCheckViolation } from "@/lib/disbursement/guard-violation"
import { requireAssetFinanceEnabled } from "@/lib/asset-finance/require-enabled"
import { parseCreditMemoInput } from "@/lib/asset-finance/credit-memo-input"
import { recordDealFinancials } from "@/lib/asset-finance/deal-financials"
import { loadDealDetail } from "@/lib/asset-finance/deal-detail"

/**
 * Record (create or replace) the deal's credit memo (manage_asset_finance):
 * the EntityFinancials figures, with DSCR and gearing computed and stored
 * (lib/asset-finance/credit-memo.ts). Money fields are whole cents as JSON
 * numbers; the ratios come back as 4-place decimal strings, null when not
 * computable. 409 once the deal is decided.
 */
export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireApiRole("READONLY")
  if (guard.error) return guard.error

  return withTenantContext(req, async (tenant) => {
    const disabled = await requireAssetFinanceEnabled(tenant.id)
    if (disabled) return disabled
    if (!canDo(guard.user.role, "manage_asset_finance")) {
      return NextResponse.json({ error: "Recording a credit memo needs the manage_asset_finance permission" }, { status: 403 })
    }
    const { id } = await params
    const parsed = parseCreditMemoInput(await req.json().catch(() => null), sastCalendarDate(new Date()))
    if ("errors" in parsed) return NextResponse.json({ error: "Invalid credit memo", fields: parsed.errors }, { status: 400 })

    let result: Awaited<ReturnType<typeof recordDealFinancials>>
    try {
      result = await prisma.$transaction((tx) =>
        recordDealFinancials(tx, { tenantId: tenant.id, userId: guard.user.id, userEmail: guard.user.email }, id, parsed.data),
      )
    } catch (error) {
      if (isCheckViolation(error)) return NextResponse.json({ error: "The deal changed; try again" }, { status: 409 })
      throw error
    }
    switch (result.kind) {
      case "not_found":
        return NextResponse.json({ error: "Deal not found" }, { status: 404 })
      case "not_editable":
        return NextResponse.json({ error: `The credit memo is fixed once a deal is ${result.status}` }, { status: 409 })
      case "schedule_unavailable":
        return NextResponse.json({ error: `The deal's schedule cannot be solved: ${result.error}` }, { status: 422 })
      case "recorded":
        return NextResponse.json({ ratios: result.ratios, deal: await loadDealDetail(tenant.id, id) })
    }
  })
}
