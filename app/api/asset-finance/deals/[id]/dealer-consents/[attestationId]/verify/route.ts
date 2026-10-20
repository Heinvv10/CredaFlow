import { NextRequest, NextResponse } from "next/server"
import { verifyDealerConsent } from "@/lib/dealer/consent"
import { refusalResponse, withDealerStaff } from "@/lib/dealer/staff-route"

/**
 * Verifies a dealer's consent evidence (manage_asset_finance; SLICE5.md
 * deviation 8): the attestation and its document are marked verified and the
 * person's ClientConsent records the credit-bureau enquiry consent, with this
 * staff member as the actor, in one audited transaction.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string; attestationId: string }> }) {
  return withDealerStaff(req, "manage_asset_finance", async ({ staff }) => {
    const { id, attestationId } = await params
    const result = await verifyDealerConsent(staff, id, attestationId)
    return result.kind === "refused" ? refusalResponse(result) : NextResponse.json(result)
  })
}
