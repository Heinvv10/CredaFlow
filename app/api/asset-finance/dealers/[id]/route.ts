import { NextRequest, NextResponse } from "next/server"
import { loadDealerForStaff } from "@/lib/dealer/staff-view"
import { parseDealerInput, updateDealer } from "@/lib/dealer/staff-dealers"
import { deactivateDealer } from "@/lib/dealer/users"
import { jsonBody, refusalResponse, withDealerStaff } from "@/lib/dealer/staff-route"

type Params = { params: Promise<{ id: string }> }

/** One dealer with its users, rates, bank accounts, commission lines and runs (manage_dealers). */
export async function GET(req: NextRequest, { params }: Params) {
  return withDealerStaff(req, "manage_dealers", async ({ tenantId }) => {
    const dealer = await loadDealerForStaff(tenantId, (await params).id)
    if (!dealer) return NextResponse.json({ error: "Dealer not found" }, { status: 404 })
    return NextResponse.json(dealer)
  })
}

/**
 * `{ active: false }` deactivates the dealer and ends every one of its users'
 * sessions (tokenVersion bumped); any other body edits its details. A dealer
 * is never reactivated or deleted.
 */
export async function PATCH(req: NextRequest, { params }: Params) {
  return withDealerStaff(req, "manage_dealers", async ({ staff }) => {
    const { id } = await params
    const body = await jsonBody(req)
    if ("active" in body) {
      if (body.active !== false || Object.keys(body).length !== 1) {
        return NextResponse.json({ error: "Send { active: false } alone to deactivate a dealer; it cannot be reactivated" }, { status: 400 })
      }
      const result = await deactivateDealer(staff, id)
      return result.kind === "refused" ? refusalResponse(result) : NextResponse.json(result)
    }
    const parsed = parseDealerInput(body, true)
    if ("errors" in parsed) return NextResponse.json({ error: "Invalid dealer", fields: parsed.errors }, { status: 400 })
    const result = await updateDealer(staff, id, parsed.data)
    return result.kind === "refused" ? refusalResponse(result) : NextResponse.json(result)
  })
}
