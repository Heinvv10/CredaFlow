import { NextRequest, NextResponse } from "next/server"
import { withDealer } from "@/lib/dealer/guards"
import { invalidResponse, readJsonBody, refusalResponse } from "@/lib/dealer/http"
import { requireDealerBaseUrl } from "@/lib/config/deployment-urls"
import { dealerPasswordUrl } from "@/lib/dealer/password-links"
import { createDealerUser, listDealerUsers, parseDealerUserInput } from "@/lib/dealer/users"

/** DEALER_ADMIN: the users of its own dealer. */
export async function GET(req: NextRequest) {
  return withDealer(req, { admin: true }, async (actor) => NextResponse.json(await listDealerUsers(actor)))
}

/**
 * DEALER_ADMIN: a new DEALER_SALES user of its own dealer, with a one-time
 * set-password link (72 h) the admin passes on; nothing is emailed. A dealer
 * admin is added by the lender's staff only. Audited DEALER_USER_CREATED.
 */
export async function POST(req: NextRequest) {
  return withDealer(req, { admin: true }, async (actor) => {
    const parsed = parseDealerUserInput(await readJsonBody(req))
    if ("errors" in parsed) return invalidResponse("user", parsed.errors)
    if (parsed.data.role !== "DEALER_SALES") {
      return invalidResponse("user", { role: "A dealer admin adds sales users; ask the lender to add another admin" })
    }
    // The link is shown once: fail before the user exists if it cannot be built.
    requireDealerBaseUrl()
    const created = await createDealerUser({ kind: "dealer", actor }, actor.dealerId, parsed.data)
    if (created.kind === "refused") return refusalResponse(created)
    return NextResponse.json(
      { id: created.userId, setPasswordUrl: dealerPasswordUrl(created.token), expiresAt: created.expiresAt.toISOString() },
      { status: 201 },
    )
  })
}
