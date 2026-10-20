import { NextRequest, NextResponse } from "next/server"
import { createDealerUser, parseDealerUserInput } from "@/lib/dealer/users"
import { dealerPasswordUrl } from "@/lib/dealer/password-links"
import { dealerLinkUnavailable, jsonBody, refusalResponse, withDealerStaff } from "@/lib/dealer/staff-route"

/**
 * Adds a user to a dealer (manage_dealers), the first DEALER_ADMIN included.
 * The answer carries the one-time set-password link (72 hours) for the staff
 * member to pass on; it is shown once and never stored or audited in clear.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withDealerStaff(req, "manage_dealers", async ({ staff }) => {
    const unavailable = dealerLinkUnavailable()
    if (unavailable) return unavailable
    const parsed = parseDealerUserInput(await jsonBody(req))
    if ("errors" in parsed) return NextResponse.json({ error: "Invalid dealer user", fields: parsed.errors }, { status: 400 })
    const result = await createDealerUser({ kind: "staff", staff }, (await params).id, parsed.data)
    if (result.kind === "refused") return refusalResponse(result)
    return NextResponse.json(
      { id: result.userId, setPasswordUrl: dealerPasswordUrl(result.token), expiresAt: result.expiresAt.toISOString() },
      { status: 201, headers: { "Cache-Control": "no-store" } },
    )
  })
}
