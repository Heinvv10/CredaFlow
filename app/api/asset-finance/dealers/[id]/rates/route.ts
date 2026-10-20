import { NextRequest, NextResponse } from "next/server"
import { parseRateInput, setCommissionRate } from "@/lib/dealer/staff-rates"
import { jsonBody, refusalResponse, withDealerStaff } from "@/lib/dealer/staff-route"

/** A dealer's commission rate from a date (manage_dealers). Rates are never edited: a change is a new date. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withDealerStaff(req, "manage_dealers", async ({ staff }) => {
    const parsed = parseRateInput(await jsonBody(req))
    if ("errors" in parsed) return NextResponse.json({ error: "Invalid commission rate", fields: parsed.errors }, { status: 400 })
    const result = await setCommissionRate(staff, (await params).id, parsed.data)
    return result.kind === "refused" ? refusalResponse(result) : NextResponse.json({ id: result.rateId }, { status: 201 })
  })
}
