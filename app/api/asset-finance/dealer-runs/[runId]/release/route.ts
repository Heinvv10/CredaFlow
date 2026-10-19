import { NextRequest, NextResponse } from "next/server"
import { releasePayableRun } from "@/lib/dealer/payable-runs"
import { jsonBody, refusalResponse, withDealerStaff } from "@/lib/dealer/staff-route"

/**
 * Records an approved run as paid (decide_asset_finance). Body
 * `{ releaseReference, taxInvoiceReference?, taxInvoiceDate? }`: the lender's
 * own EFT reference and, required when the run carries VAT, the VAT-vendor
 * dealer's tax invoice. No money moves here; refused once the run's bank
 * account is no longer APPROVED.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ runId: string }> }) {
  return withDealerStaff(req, "decide_asset_finance", async ({ staff }) => {
    const result = await releasePayableRun(staff, (await params).runId, await jsonBody(req))
    if (result.kind === "refused") return refusalResponse(result)
    return NextResponse.json(result)
  })
}
