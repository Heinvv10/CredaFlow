import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { canDo, requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { sastCalendarDate } from "@/lib/date/sast"
import { isCheckViolation } from "@/lib/disbursement/guard-violation"
import { requireAssetFinanceEnabled } from "@/lib/asset-finance/require-enabled"
import { parseDealCreate } from "@/lib/asset-finance/deal-input"
import { createDeal } from "@/lib/asset-finance/deal-create"
import { loadDealDetail } from "@/lib/asset-finance/deal-detail"

/**
 * Create an asset-finance deal (manage_asset_finance): the entity's DRAFT
 * LoanApplication and its AssetFinanceDeal in one transaction
 * (lib/asset-finance/deal-create.ts). 400 for a malformed body; 422 when the
 * entity, supplier, product, rate or structure is refused; 409 when the asset
 * is released or already on an open deal. 201 with the deal detail.
 */
export async function POST(req: NextRequest) {
  const guard = await requireApiRole("READONLY")
  if (guard.error) return guard.error

  return withTenantContext(req, async (tenant) => {
    const disabled = await requireAssetFinanceEnabled(tenant.id)
    if (disabled) return disabled
    if (!canDo(guard.user.role, "manage_asset_finance")) {
      return NextResponse.json({ error: "Creating a deal needs the manage_asset_finance permission" }, { status: 403 })
    }

    const parsed = parseDealCreate(await req.json().catch(() => null), sastCalendarDate(new Date()))
    if ("errors" in parsed) return NextResponse.json({ error: "Invalid deal", fields: parsed.errors }, { status: 400 })

    let result: Awaited<ReturnType<typeof createDeal>>
    try {
      result = await prisma.$transaction((tx) =>
        createDeal(tx, { tenantId: tenant.id, userId: guard.user.id, userEmail: guard.user.email, input: parsed.data }),
      )
    } catch (error) {
      if (isCheckViolation(error)) {
        return NextResponse.json({ error: "The database refused the deal; check the amounts and try again" }, { status: 409 })
      }
      throw error
    }
    if (result.kind === "refused") return NextResponse.json({ error: result.error }, { status: result.status })
    return NextResponse.json(await loadDealDetail(tenant.id, result.dealId), { status: 201 })
  })
}
