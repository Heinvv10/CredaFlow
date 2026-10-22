import { NextRequest } from "next/server"
import { recordedCallerIp } from "@/lib/rate-limit"
import { revealPositionTrail } from "@/lib/telematics/position-trail"
import { jsonBody, telematicsResponse, withTelematicsStaff } from "@/lib/telematics/route"

type Params = { params: Promise<{ loanId: string }> }

/**
 * The loan's asset's position trail (view_asset_position), body
 * `{ context: "THEFT" | "RECOVERY" | "LEGAL_MATTER" }`: only for a purpose the
 * loan has now (409), only from this loan's tenure and within retention. Every
 * view writes a TelematicsPositionAccess row (view TRAIL) before the answer
 * leaves (lib/telematics/position-trail.ts). POST: an explicit act.
 */
export async function POST(req: NextRequest, { params }: Params) {
  const { loanId } = await params
  return withTelematicsStaff(req, "view_asset_position", async (actor) =>
    telematicsResponse(await revealPositionTrail(actor, loanId, await jsonBody(req), { ipAddress: recordedCallerIp(req), userAgent: req.headers.get("user-agent") })))
}
