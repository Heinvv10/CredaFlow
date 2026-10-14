import { NextRequest, NextResponse } from "next/server"
import { withSigningStaff } from "@/lib/asset-finance/signing-route"
import { contractDeal } from "@/lib/asset-finance/signing-contract"
import { loadDealDetail } from "@/lib/asset-finance/deal-detail"

/**
 * APPROVED → CONTRACTED (manage_asset_finance) once every required signer is
 * satisfied: e-signed, or a wet-ink scan confirmed by a second user. 409 lists
 * the outstanding signers (audited); the database refuses the same move on its
 * own (guardAssetDealContract). 409 (audited) when the agreement re-rendered
 * now does not hash to the digest that was signed.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return withSigningStaff(req, { dealId: id, manage: true }, async ({ tenantId, user, refuse }) => {
    const body = await req.json().catch(() => null) as { providerSignature?: unknown } | null
    const providerSignature = typeof body?.providerSignature === "string" ? body.providerSignature : undefined
    const result = await contractDeal({ tenantId, userId: user.id, userEmail: user.email }, id, providerSignature)
    switch (result.kind) {
      case "not_found":
        return NextResponse.json({ error: "Deal not found" }, { status: 404 })
      case "not_approved":
        return NextResponse.json({ error: `Only an APPROVED deal is contracted; this one is ${result.status}` }, { status: 409 })
      case "no_authority":
        return refuse("no_authority", 409, "Nobody can sign for this entity; the deal cannot be contracted")
      case "incomplete":
        return refuse("signers_outstanding", 409, "Signatures are outstanding", { outstanding: result.outstanding })
      case "agreement_changed":
        return refuse(
          "agreement_changed", 409,
          "The agreement rendered from the deal as it stands is not the one that was signed (the deal, its asset or the reference rate changed); cancel the deal and start again",
        )
      case "provider_signature_required":
        return refuse("provider_signature_required", 422, "Entity NCA contracting needs an explicit provider signature after the representative has signed")
      case "contracted":
        return NextResponse.json(await loadDealDetail(tenantId, id))
    }
  })
}
