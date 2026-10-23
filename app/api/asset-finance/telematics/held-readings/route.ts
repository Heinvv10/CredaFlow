import { NextRequest, NextResponse } from "next/server"
import { listHeldReadings } from "@/lib/telematics/held-readings"
import { withTelematicsStaff } from "@/lib/telematics/route"

/** Tracker readings held for a decision (manage_asset_finance), newest first. */
export async function GET(req: NextRequest) {
  return withTelematicsStaff(req, "manage_asset_finance", async ({ tenantId }) =>
    NextResponse.json({ heldReadings: await listHeldReadings(tenantId) }))
}
