import { NextRequest, NextResponse } from "next/server"
import { dealerPasswordUrl, issueDealerPasswordLink } from "@/lib/dealer/password-links"
import { dealerLinkUnavailable, refusalResponse, withDealerStaff } from "@/lib/dealer/staff-route"

/** A fresh one-time set-password link for a dealer user; its sessions end (manage_dealers). */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string; userId: string }> }) {
  return withDealerStaff(req, "manage_dealers", async ({ staff }) => {
    const unavailable = dealerLinkUnavailable()
    if (unavailable) return unavailable
    const { id, userId } = await params
    const result = await issueDealerPasswordLink(staff, id, userId)
    if (result.kind === "refused") return refusalResponse(result)
    return NextResponse.json(
      { setPasswordUrl: dealerPasswordUrl(result.token), expiresAt: result.expiresAt.toISOString() },
      { headers: { "Cache-Control": "no-store" } },
    )
  })
}
