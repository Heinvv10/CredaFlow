import { NextRequest, NextResponse } from "next/server"
import { acceptHeldReading, rejectHeldReading } from "@/lib/telematics/held-readings"
import { jsonBody, telematicsResponse, withTelematicsStaff } from "@/lib/telematics/route"

type Params = { params: Promise<{ id: string; action: string }> }

/**
 * `accept` a held tracker reading (written as TELEMATICS, recorded by the
 * accepter; a lower one is refused 422), or `reject` it with `{ note }`
 * (manage_asset_finance). Audited.
 */
export async function POST(req: NextRequest, { params }: Params) {
  const { id, action } = await params
  if (action !== "accept" && action !== "reject") return NextResponse.json({ error: "Not found" }, { status: 404 })
  return withTelematicsStaff(req, "manage_asset_finance", async (actor) => {
    const body = await jsonBody(req)
    return telematicsResponse(action === "accept" ? await acceptHeldReading(actor, id, body) : await rejectHeldReading(actor, id, body))
  })
}
