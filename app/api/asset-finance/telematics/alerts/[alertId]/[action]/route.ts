import { NextRequest, NextResponse } from "next/server"
import { acknowledgeAlert, resolveAlert } from "@/lib/telematics/alerts"
import { jsonBody, telematicsResponse, withTelematicsStaff } from "@/lib/telematics/route"

type Params = { params: Promise<{ alertId: string; action: string }> }

/** `acknowledge` an OPEN tracker alert, or `resolve` one with `{ note }` (work_telematics_alerts). Audited. */
export async function POST(req: NextRequest, { params }: Params) {
  const { alertId, action } = await params
  if (action !== "acknowledge" && action !== "resolve") return NextResponse.json({ error: "Not found" }, { status: 404 })
  return withTelematicsStaff(req, "work_telematics_alerts", async (actor) =>
    telematicsResponse(action === "acknowledge" ? await acknowledgeAlert(actor, alertId) : await resolveAlert(actor, alertId, await jsonBody(req))))
}
