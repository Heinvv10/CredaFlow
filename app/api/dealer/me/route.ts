import { NextRequest, NextResponse } from "next/server"
import { dealerNotFound, withDealer } from "@/lib/dealer/guards"
import { loadDealerProfile } from "@/lib/dealer/users"

/** The signed-in dealer user and its dealer. */
export async function GET(req: NextRequest) {
  return withDealer(req, {}, async (actor) => {
    const profile = await loadDealerProfile(actor)
    return profile ? NextResponse.json(profile) : dealerNotFound()
  })
}
