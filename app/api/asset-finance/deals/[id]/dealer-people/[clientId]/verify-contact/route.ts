import { NextRequest, NextResponse } from "next/server"
import { verifyDealerContact } from "@/lib/dealer/contact-verification"
import { refusalResponse, withDealerStaff } from "@/lib/dealer/staff-route"

/**
 * Records that a staff member verified the contact details a dealer captured
 * for a person on this deal (manage_asset_finance; review finding S1). Until
 * then the person's portal is not activated and no signing code is sent to
 * them. Once, audited.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string; clientId: string }> }) {
  return withDealerStaff(req, "manage_asset_finance", async ({ staff }) => {
    const { id, clientId } = await params
    const result = await verifyDealerContact(staff, id, clientId)
    return result.kind === "refused" ? refusalResponse(result) : NextResponse.json(result)
  })
}
