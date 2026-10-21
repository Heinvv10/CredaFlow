import { NextRequest } from "next/server"
import { removeTrackerDevice } from "@/lib/telematics/devices"
import { jsonBody, telematicsResponse, withTelematicsStaff } from "@/lib/telematics/route"

type Params = { params: Promise<{ deviceId: string }> }

/** Removes a tracker device, once (manage_asset_finance). Body: `{ removedOn? }` (default today). Audited. */
export async function POST(req: NextRequest, { params }: Params) {
  const { deviceId } = await params
  return withTelematicsStaff(req, "manage_asset_finance", async (actor) =>
    telematicsResponse(await removeTrackerDevice(actor, deviceId, await jsonBody(req))))
}
