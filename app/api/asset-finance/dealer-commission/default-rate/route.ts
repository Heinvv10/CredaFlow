import { NextRequest, NextResponse } from "next/server"
import { parseRateInput, setCommissionRate } from "@/lib/dealer/staff-rates"
import { jsonBody, refusalResponse, withDealerStaff } from "@/lib/dealer/staff-route"

/** The tenant default commission rate from a date, for dealers with no rate of their own (manage_dealers). */
export async function POST(req: NextRequest) {
  return withDealerStaff(req, "manage_dealers", async ({ staff }) => {
    const parsed = parseRateInput(await jsonBody(req))
    if ("errors" in parsed) return NextResponse.json({ error: "Invalid commission rate", fields: parsed.errors }, { status: 400 })
    const result = await setCommissionRate(staff, null, parsed.data)
    return result.kind === "refused" ? refusalResponse(result) : NextResponse.json({ id: result.rateId }, { status: 201 })
  })
}
