import { NextRequest } from "next/server"
import { leaseStaffAction } from "@/lib/asset-finance/lease-route"
import { requestMeterReadingVoid } from "@/lib/asset-finance/meter-void"

type Params = { params: Promise<{ loanId: string; readingId: string }> }

/**
 * Ask for a wrong meter reading to be voided (manage_asset_finance). Body
 * `{ reason }` (10 to 500 characters). A second staff user decides it
 * (…/reading-voids/[voidId]/decide). Audited METER_READING_VOID_REQUESTED.
 */
export async function POST(req: NextRequest, { params }: Params) {
  const { loanId, readingId } = await params
  return leaseStaffAction(req, { loanId, permission: "manage_asset_finance", action: "meter_reading_void" }, (tx, actor, _today, body) =>
    requestMeterReadingVoid(tx, actor, { loanId, readingId, reason: body.reason }))
}
