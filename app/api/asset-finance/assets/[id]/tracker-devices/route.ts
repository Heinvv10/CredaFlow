import { NextRequest } from "next/server"
import { registerTrackerDevice } from "@/lib/telematics/devices"
import { jsonBody, telematicsResponse, withTelematicsStaff } from "@/lib/telematics/route"

type Params = { params: Promise<{ id: string }> }

/**
 * Registers a tracker device on the asset (manage_asset_finance). Body:
 * `{ provider, externalDeviceId, installedOn }`. The provider must be
 * registered; the simulated one is refused on a deployed build that does not
 * allow it. One live device per asset (409). Audited.
 */
export async function POST(req: NextRequest, { params }: Params) {
  const { id } = await params
  return withTelematicsStaff(req, "manage_asset_finance", async (actor) =>
    telematicsResponse(await registerTrackerDevice(actor, id, await jsonBody(req)), true))
}
