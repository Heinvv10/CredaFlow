import { NextRequest } from "next/server"
import { endTheftReport } from "@/lib/telematics/theft-reports"
import { jsonBody, telematicsResponse, withTelematicsStaff } from "@/lib/telematics/route"

type Params = { params: Promise<{ loanId: string; reportId: string }> }

/**
 * Ends a theft report early, body `{ reason }` (the asset found): THEFT stops holding at once. Once only.
 * Audited TELEMATICS_THEFT_REPORT_ENDED.
 */
export async function POST(req: NextRequest, { params }: Params) {
  const { loanId, reportId } = await params
  return withTelematicsStaff(req, "view_asset_position", async (actor) =>
    telematicsResponse(await endTheftReport(actor, loanId, reportId, await jsonBody(req))))
}
