import { NextRequest } from "next/server"
import { leaseStaffAction } from "@/lib/asset-finance/lease-route"
import { decideMeterReadingVoid } from "@/lib/asset-finance/meter-void"

type Params = { params: Promise<{ loanId: string; voidId: string }> }

/**
 * Approve or reject a meter-reading void (manage_asset_finance), body
 * `{ decision: "APPROVE" | "REJECT" }`: by a second staff user, never the one
 * who asked (the database refuses it too). Approval voids the reading.
 */
export async function POST(req: NextRequest, { params }: Params) {
  const { loanId, voidId } = await params
  return leaseStaffAction(req, { loanId, permission: "manage_asset_finance", action: "meter_reading_void_decision" }, (tx, actor, _today, body) =>
    decideMeterReadingVoid(tx, actor, { loanId, voidId, decision: body.decision }))
}
