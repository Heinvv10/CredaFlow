import { NextRequest, NextResponse } from "next/server"
import { withPayoutStaff } from "@/lib/asset-finance/payout-route"
import { approvePayout } from "@/lib/asset-finance/payout"
import { loadPayoutPanel } from "@/lib/asset-finance/payout-view"

/**
 * The second approval of a payout at or above the dual-approval threshold
 * (decide_asset_finance). Its creator is refused (403, audited); the
 * database refuses the same (CHECK Payout_four_eyes).
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return withPayoutStaff(req, { dealId: id, permission: "decide_asset_finance" }, async ({ tenantId, user, refuse }) => {
    const result = await approvePayout({ tenantId, userId: user.id, userEmail: user.email }, id)
    switch (result.kind) {
      case "not_found":
        return NextResponse.json({ error: "Payout not found" }, { status: 404 })
      case "not_pending":
        return NextResponse.json({ error: `Only a payout awaiting approval is approved; this one is ${result.status}` }, { status: 409 })
      case "same_user":
        return refuse("four_eyes", 403, "The payout's creator cannot approve it; a second user must")
      case "approved":
        return NextResponse.json(await loadPayoutPanel(tenantId, id))
    }
  })
}
