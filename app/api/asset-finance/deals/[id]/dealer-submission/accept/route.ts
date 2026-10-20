import { NextRequest, NextResponse } from "next/server"
import { isCheckViolation } from "@/lib/disbursement/guard-violation"
import { loadDealDetail } from "@/lib/asset-finance/deal-detail"
import { screenOnSubmit } from "@/lib/screening/on-submit"
import { acceptDealerSubmission } from "@/lib/dealer/submit"
import { refusalResponse, withDealerStaff } from "@/lib/dealer/staff-route"

/**
 * Accepts a deal the dealer submitted (manage_asset_finance; SLICE5.md
 * deviation 1): the unchanged submitDeal runs as this staff member, so the
 * NCA classification and any override request are the lender's. Answers as
 * POST …/submit does; 409 when the dealer has not submitted the deal.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withDealerStaff(req, "manage_asset_finance", async ({ tenantId, staff, user }) => {
    const { id } = await params
    let result: Awaited<ReturnType<typeof acceptDealerSubmission>>
    try {
      result = await acceptDealerSubmission(staff, id)
    } catch (error) {
      if (isCheckViolation(error)) {
        return NextResponse.json({ error: "The deal changed while it was being submitted; try again" }, { status: 409 })
      }
      throw error
    }
    switch (result.kind) {
      case "refused":
        return refusalResponse(result)
      case "not_found":
        return NextResponse.json({ error: "Deal not found" }, { status: 404 })
      case "not_draft":
        return NextResponse.json({ error: `Only a DRAFT deal is submitted; this one is ${result.status}` }, { status: 409 })
      case "regime_frozen":
        return NextResponse.json({ error: `The NCA regime is frozen once an application is ${result.status}` }, { status: 409 })
      case "refused_nca":
        return NextResponse.json({ refusedNca: true, reason: result.reason, awaitingRegimeApproval: false, deal: await loadDealDetail(tenantId, id) })
      case "submitted":
        // PEP / sanctions screening of the borrower, as on a staff submit; never blocks it.
        void screenOnSubmit({ tenantId, dealId: id, actor: { id: user.id, email: user.email } })
        return NextResponse.json({
          refusedNca: false, awaitingRegimeApproval: result.awaitingRegimeApproval, deal: await loadDealDetail(tenantId, id),
        })
    }
  })
}
