import { NextRequest } from "next/server"
import { recordedCallerIp } from "@/lib/rate-limit"
import { revealPosition } from "@/lib/telematics/position-view"
import { jsonBody, telematicsResponse, withTelematicsStaff } from "@/lib/telematics/route"

type Params = { params: Promise<{ loanId: string }> }

/**
 * Reveals the loan's asset's last known position (view_asset_position), body
 * `{ context: "RECOVERY" | "LEGAL_MATTER" }`. Only for a loan in default,
 * legal action or recovery (409), only from this loan's tenure and within
 * retention. Every reveal writes a TelematicsPositionAccess row before the
 * answer leaves (lib/telematics/position-view.ts). POST: an explicit act,
 * never a page load.
 */
export async function POST(req: NextRequest, { params }: Params) {
  const { loanId } = await params
  return withTelematicsStaff(req, "view_asset_position", async (actor) =>
    telematicsResponse(await revealPosition(actor, loanId, await jsonBody(req), { ipAddress: recordedCallerIp(req), userAgent: req.headers.get("user-agent") })))
}
