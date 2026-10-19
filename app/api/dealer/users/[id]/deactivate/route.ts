import { NextRequest, NextResponse } from "next/server"
import { withDealer } from "@/lib/dealer/guards"
import { refusalResponse } from "@/lib/dealer/http"
import { deactivateDealerUser } from "@/lib/dealer/users"

type Params = { params: Promise<{ id: string }> }

/**
 * DEALER_ADMIN: deactivate a user of its own dealer (never itself). The user's
 * tokenVersion is bumped, so its sessions end on their next request; any
 * pending link is cleared. Audited DEALER_USER_DEACTIVATED.
 */
export async function POST(req: NextRequest, { params }: Params) {
  return withDealer(req, { admin: true }, async (actor) => {
    const { id } = await params
    const result = await deactivateDealerUser({ kind: "dealer", actor }, actor.dealerId, id)
    if (result.kind === "refused") return refusalResponse(result)
    return NextResponse.json({ ok: true })
  })
}
