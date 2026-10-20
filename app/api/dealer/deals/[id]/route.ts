import { NextRequest, NextResponse } from "next/server"
import { dealerNotFound, withDealer } from "@/lib/dealer/guards"
import { loadDealerDealView } from "@/lib/dealer/deal-view"

type Params = { params: Promise<{ id: string }> }

/**
 * One of this dealer's deals as the dealer may see it (lib/dealer/deal-view.ts):
 * status, missing items, document requests, signing progress, booking and its
 * commission lines; never the decision, its reasons, bureau results, the NCA
 * regime or the payout. Any other deal is 404.
 */
export async function GET(req: NextRequest, { params }: Params) {
  return withDealer(req, {}, async (actor) => {
    const { id } = await params
    const view = await loadDealerDealView(actor, id)
    return view ? NextResponse.json(view) : dealerNotFound()
  })
}
