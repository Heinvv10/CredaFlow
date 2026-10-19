import { NextRequest, NextResponse } from "next/server"
import { requestDealerDocument } from "@/lib/dealer/document-requests"
import { jsonBody, refusalResponse, withDealerStaff } from "@/lib/dealer/staff-route"

/**
 * Asks the dealer for a document on its deal (manage_asset_finance). Body
 * `{ docType, note }`; the note is shown to the dealer, so it never carries
 * a credit reason.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withDealerStaff(req, "manage_asset_finance", async ({ staff }) => {
    const body = await jsonBody(req)
    const result = await requestDealerDocument(staff, (await params).id, { docType: body.docType, note: body.note })
    return result.kind === "refused" ? refusalResponse(result) : NextResponse.json({ id: result.requestId }, { status: 201 })
  })
}
