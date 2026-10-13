import { NextRequest, NextResponse } from "next/server"
import { withSigningStaff } from "@/lib/asset-finance/signing-route"
import { contractDeal } from "@/lib/asset-finance/signing-contract"
import { loadDealDetail } from "@/lib/asset-finance/deal-detail"

/**
 * APPROVED → CONTRACTED (manage_asset_finance) once every required signer is
 * satisfied: e-signed, or a wet-ink scan confirmed by a second user. 409 lists
 * the outstanding signers (audited); the database refuses the same move on its
 * own (guardAssetDealContract).
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return withSigningStaff(req, { dealId: id, manage: true }, async ({ tenantId, user, refuse }) => {
    const result = await contractDeal({ tenantId, userId: user.id, userEmail: user.email }, id)
    switch (result.kind) {
      case "not_found":
        return NextResponse.json({ error: "Deal not found" }, { status: 404 })
      case "not_approved":
        return NextResponse.json({ error: `Only an APPROVED deal is contracted; this one is ${result.status}` }, { status: 409 })
      case "no_authority":
        return refuse("no_authority", 409, "Nobody can sign for this entity; the deal cannot be contracted")
      case "incomplete":
        return refuse("signers_outstanding", 409, "Signatures are outstanding", { outstanding: result.outstanding })
      case "contracted":
        return NextResponse.json(await loadDealDetail(tenantId, id))
    }
  })
}
