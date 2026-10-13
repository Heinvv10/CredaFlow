import { NextRequest, NextResponse } from "next/server"
import { withPayoutStaff } from "@/lib/asset-finance/payout-route"
import { createPayout } from "@/lib/asset-finance/payout"
import { loadPayoutPanel } from "@/lib/asset-finance/payout-view"

type Params = { params: Promise<{ id: string }> }

/** The deal's payout panel: checklist, evidence documents, payout, booked loan (any staff role). */
export async function GET(req: NextRequest, { params }: Params) {
  const { id } = await params
  return withPayoutStaff(req, { dealId: id, permission: null }, async ({ tenantId }) => {
    const panel = await loadPayoutPanel(tenantId, id)
    return panel ? NextResponse.json(panel) : NextResponse.json({ error: "Deal not found" }, { status: 404 })
  })
}

/**
 * Creates the supplier payout (decide_asset_finance): the asset's cash price
 * incl. VAT less deposit and trade-in, to the supplier's APPROVED account,
 * once every required checklist item is confirmed. At or above the tenant's
 * dual-approval threshold it is PENDING_APPROVAL for a second user; below it
 * the creation is the approval. Refusals are audited; the database refuses
 * the same (guardPayout).
 */
export async function POST(req: NextRequest, { params }: Params) {
  const { id } = await params
  return withPayoutStaff(req, { dealId: id, permission: "decide_asset_finance" }, async ({ tenantId, user, refuse }) => {
    const result = await createPayout({ tenantId, userId: user.id, userEmail: user.email }, id)
    switch (result.kind) {
      case "not_found":
        return NextResponse.json({ error: "Deal not found" }, { status: 404 })
      case "not_contracted":
        return refuse("not_contracted", 409, `A payout is created only for a CONTRACTED deal; this one is ${result.status}`)
      case "exists":
        return NextResponse.json({ error: "This deal already has a payout" }, { status: 409 })
      case "checklist_open":
        return refuse("checklist_open", 409, "Every required checklist item must be confirmed first", { open: result.open })
      case "no_approved_account":
        return refuse("no_approved_account", 409, "The supplier has no APPROVED bank account")
      case "amount_invalid":
        return refuse("amount_invalid", 422, `The payout amount ${result.amountCents} cents is not payable`)
      case "created":
        return NextResponse.json(await loadPayoutPanel(tenantId, id), { status: 201 })
    }
  })
}
