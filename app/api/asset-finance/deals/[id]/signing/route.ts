import { NextRequest, NextResponse } from "next/server"
import { withSigningStaff } from "@/lib/asset-finance/signing-route"
import { prepareDealDocuments } from "@/lib/asset-finance/signing-prepare"
import { loadStaffSigningPanel } from "@/lib/asset-finance/signing-view"

type Params = { params: Promise<{ id: string }> }

/** The deal's signer rows and their state (any staff role). */
export async function GET(req: NextRequest, { params }: Params) {
  const { id } = await params
  return withSigningStaff(req, { dealId: id, manage: false }, async ({ tenantId }) => {
    const panel = await loadStaffSigningPanel(tenantId, id)
    if (!panel) return NextResponse.json({ error: "Deal not found" }, { status: 404 })
    return NextResponse.json(panel)
  })
}

/**
 * Prepare an APPROVED deal's documents (manage_asset_finance;
 * lib/asset-finance/signing-prepare.ts): render and store the agreement, the
 * resolution and a suretyship per surety, and create the signer rows. 409
 * once anything is signed or scanned, when the deal is not APPROVED, or when
 * nobody has authority to sign; 422 when the lender identity is not
 * configured or the schedule cannot be solved.
 */
export async function POST(req: NextRequest, { params }: Params) {
  const { id } = await params
  return withSigningStaff(req, { dealId: id, manage: true }, async ({ tenantId, user, refuse }) => {
    const result = await prepareDealDocuments({ tenantId, userId: user.id, userEmail: user.email }, id)
    switch (result.kind) {
      case "not_found":
        return NextResponse.json({ error: "Deal not found" }, { status: 404 })
      case "not_approved":
        return NextResponse.json({ error: `Documents are prepared for an APPROVED deal; this one is ${result.status}` }, { status: 409 })
      case "signing_started":
        return refuse("signing_started", 409, "Signing has started; the documents can no longer be prepared again")
      case "no_authority":
        return refuse(
          "no_authority", 409,
          "Nobody can sign for this entity: record its authorised signatories (or, for a company or trust, its directors or trustees)",
        )
      case "people_changed":
        return NextResponse.json({ error: "The entity's people changed while the documents were prepared; try again" }, { status: 409 })
      case "prepared":
        return NextResponse.json(await loadStaffSigningPanel(tenantId, id))
    }
  })
}
