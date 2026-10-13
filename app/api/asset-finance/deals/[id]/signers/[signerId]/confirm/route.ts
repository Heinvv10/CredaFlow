import { NextRequest, NextResponse } from "next/server"
import { withSigningStaff } from "@/lib/asset-finance/signing-route"
import { confirmWetInkScan } from "@/lib/asset-finance/signing-wet-ink"
import { loadStaffSigningPanel } from "@/lib/asset-finance/signing-view"

/**
 * Confirm a wet-ink scan (manage_asset_finance). Four eyes: the user who
 * uploaded the scan may not confirm it — refused 403 and audited here, and
 * refused by the database (CHECK DealSigner_wet_ink_four_eyes) regardless.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string; signerId: string }> }) {
  const { id, signerId } = await params
  return withSigningStaff(req, { dealId: id, manage: true }, async ({ tenantId, user, refuse }) => {
    const result = await confirmWetInkScan({ tenantId, userId: user.id, userEmail: user.email }, id, signerId)
    switch (result.kind) {
      case "not_found":
        return NextResponse.json({ error: "Signer not found" }, { status: 404 })
      case "four_eyes":
        return refuse("four_eyes", 403, "A scan is confirmed by someone other than the user who uploaded it", { signerId })
      case "not_open":
        return NextResponse.json({ error: result.reason }, { status: 409 })
      case "done":
        return NextResponse.json(await loadStaffSigningPanel(tenantId, id))
    }
  })
}
