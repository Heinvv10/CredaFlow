import { NextRequest } from "next/server"
import { verifyTrackerMeter } from "@/lib/telematics/devices"
import { jsonBody, telematicsResponse, withTelematicsStaff } from "@/lib/telematics/route"

type Params = { params: Promise<{ deviceId: string }> }

/**
 * Records that staff compared a live device's meter with the asset's own
 * (manage_asset_finance), body `{ note }`. Once; audited. Until then a real
 * provider's meter feeds no lease reading (METER_UNVERIFIED).
 */
export async function POST(req: NextRequest, { params }: Params) {
  const { deviceId } = await params
  return withTelematicsStaff(req, "manage_asset_finance", async (actor) =>
    telematicsResponse(await verifyTrackerMeter(actor, deviceId, await jsonBody(req))))
}
