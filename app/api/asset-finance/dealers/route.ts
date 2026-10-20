import { NextRequest, NextResponse } from "next/server"
import { defaultRateHistory, listDealersForStaff } from "@/lib/dealer/staff-view"
import { createDealer, parseDealerInput } from "@/lib/dealer/staff-dealers"
import { jsonBody, refusalResponse, withDealerStaff } from "@/lib/dealer/staff-route"

/** The lender's dealers and brokers, and the tenant default commission rate history (manage_dealers). */
export async function GET(req: NextRequest) {
  return withDealerStaff(req, "manage_dealers", async ({ tenantId }) => {
    const [dealers, defaultRates] = await Promise.all([listDealersForStaff(tenantId), defaultRateHistory(tenantId)])
    return NextResponse.json({ dealers, defaultRates })
  })
}

/** Registers a dealer or broker (manage_dealers). Its users, rates and bank account are added on its page. */
export async function POST(req: NextRequest) {
  return withDealerStaff(req, "manage_dealers", async ({ staff }) => {
    const parsed = parseDealerInput(await jsonBody(req), false)
    if ("errors" in parsed) return NextResponse.json({ error: "Invalid dealer", fields: parsed.errors }, { status: 400 })
    const result = await createDealer(staff, parsed.data)
    if (result.kind === "refused") return refusalResponse(result)
    return NextResponse.json({ id: result.dealerId }, { status: 201 })
  })
}
