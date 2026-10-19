import { NextRequest, NextResponse } from "next/server"
import { withDealer } from "@/lib/dealer/guards"
import { readJsonBody } from "@/lib/dealer/http"
import { previewDealerDeal } from "@/lib/dealer/preview"

/**
 * Price a structure for one of this dealer's assets (writes nothing). A
 * structure that cannot be solved is 200 with `{ error }`; malformed fields
 * 400; another asset 404.
 */
export async function POST(req: NextRequest) {
  return withDealer(req, {}, async (actor) => {
    const answer = await previewDealerDeal(actor, await readJsonBody(req))
    return NextResponse.json(answer.body, { status: answer.status })
  })
}
