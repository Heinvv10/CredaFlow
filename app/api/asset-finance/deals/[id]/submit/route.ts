import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { canDo, requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { isCheckViolation } from "@/lib/disbursement/guard-violation"
import { requireAssetFinanceEnabled } from "@/lib/asset-finance/require-enabled"
import { submitDeal } from "@/lib/asset-finance/deal-submit"
import { loadDealDetail } from "@/lib/asset-finance/deal-detail"
import { screenOnSubmit } from "@/lib/screening/on-submit"

/**
 * Submit a DRAFT deal (manage_asset_finance; lib/asset-finance/deal-submit.ts).
 * The classifier runs as the submitting user. 200 with the deal detail and:
 *   - `refusedNca: true` and `reason` when the application stays NCA with no
 *     pending override (slice 1 finances non-NCA deals only: the deal is
 *     REFUSED_NCA and the application DECLINED, audited);
 *   - `awaitingRegimeApproval: true` when a NON_NCA override awaits a second
 *     approver (POST /api/asset-finance/nca-overrides/[id]/decide).
 * 409 when the deal is not DRAFT.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireApiRole("READONLY")
  if (guard.error) return guard.error

  return withTenantContext(req, async (tenant) => {
    const disabled = await requireAssetFinanceEnabled(tenant.id)
    if (disabled) return disabled
    if (!canDo(guard.user.role, "manage_asset_finance")) {
      return NextResponse.json({ error: "Submitting a deal needs the manage_asset_finance permission" }, { status: 403 })
    }
    const { id } = await params

    let result: Awaited<ReturnType<typeof submitDeal>>
    try {
      result = await prisma.$transaction((tx) =>
        submitDeal(tx, { tenantId: tenant.id, userId: guard.user.id, userEmail: guard.user.email }, id),
      )
    } catch (error) {
      if (isCheckViolation(error)) {
        return NextResponse.json({ error: "The deal changed while it was being submitted; try again" }, { status: 409 })
      }
      throw error
    }
    switch (result.kind) {
      case "not_found":
        return NextResponse.json({ error: "Deal not found" }, { status: 404 })
      case "not_draft":
        return NextResponse.json({ error: `Only a DRAFT deal is submitted; this one is ${result.status}` }, { status: 409 })
      case "regime_frozen":
        return NextResponse.json({ error: `The NCA regime is frozen once an application is ${result.status}` }, { status: 409 })
      case "refused_nca":
        return NextResponse.json({
          refusedNca: true,
          reason: result.reason,
          awaitingRegimeApproval: false,
          deal: await loadDealDetail(tenant.id, id),
        })
      case "submitted":
        // PEP / sanctions screening of the borrower; never blocks or fails the submission.
        void screenOnSubmit({ tenantId: tenant.id, dealId: id, actor: { id: guard.user.id, email: guard.user.email } })
        return NextResponse.json({
          refusedNca: false,
          awaitingRegimeApproval: result.awaitingRegimeApproval,
          deal: await loadDealDetail(tenant.id, id),
        })
    }
  })
}
