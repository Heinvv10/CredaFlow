import { NextRequest } from "next/server"
import { recordTheftReport } from "@/lib/telematics/theft-reports"
import { jsonBody, telematicsResponse, withTelematicsStaff } from "@/lib/telematics/route"

type Params = { params: Promise<{ loanId: string }> }

/**
 * Records a theft reported to SAPS (view_asset_position), body
 * `{ sapsCaseNumber, reportedOn, renewsReportId? }`: the THEFT position
 * purpose holds for 30 days from today (lib/telematics/theft-reports.ts).
 * Audited TELEMATICS_THEFT_REPORT_RECORDED.
 */
export async function POST(req: NextRequest, { params }: Params) {
  const { loanId } = await params
  return withTelematicsStaff(req, "view_asset_position", async (actor) =>
    telematicsResponse(await recordTheftReport(actor, loanId, await jsonBody(req)), true))
}
