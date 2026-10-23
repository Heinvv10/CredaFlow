import { NextRequest } from "next/server"
import { confirmTheftReport } from "@/lib/telematics/theft-reports"
import { telematicsResponse, withTelematicsStaff } from "@/lib/telematics/route"

type Params = { params: Promise<{ loanId: string; reportId: string }> }

/**
 * A second person confirms a recorded theft report (view_asset_position, never the one who recorded it; the
 * database refuses that too). THEFT holds only once confirmed. Audited TELEMATICS_THEFT_REPORT_CONFIRMED.
 */
export async function POST(req: NextRequest, { params }: Params) {
  const { loanId, reportId } = await params
  return withTelematicsStaff(req, "view_asset_position", async (actor) => telematicsResponse(await confirmTheftReport(actor, loanId, reportId)))
}
