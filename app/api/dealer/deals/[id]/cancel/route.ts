import { NextRequest, NextResponse } from "next/server"
import { withDealer } from "@/lib/dealer/guards"
import { readJsonBody, refusalResponse } from "@/lib/dealer/http"
import { cancelDealerDraft } from "@/lib/dealer/cancel"
import { parseCancelInput } from "@/lib/asset-finance/deal-cancel"

type Params = { params: Promise<{ id: string }> }

/**
 * Cancel a draft not yet handed to the lender (`{ reason }`, 10 to 1000
 * characters): DEALER_ADMIN any of the dealer's, DEALER_SALES its own; anything
 * else is 404 (another dealer's) or 409 (with the lender). Audited
 * DEALER_DEAL_CANCELLED.
 */
export async function POST(req: NextRequest, { params }: Params) {
  return withDealer(req, {}, async (actor) => {
    const { id } = await params
    const input = parseCancelInput(await readJsonBody(req))
    if (typeof input === "string") return NextResponse.json({ error: input }, { status: 400 })
    const result = await cancelDealerDraft(actor, id, input.reason)
    if (result.kind === "refused") return refusalResponse(result)
    return NextResponse.json({ status: "CANCELLED" })
  })
}
