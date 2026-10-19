import { NextRequest, NextResponse } from "next/server"
import { createPayableRun } from "@/lib/dealer/payable-runs"
import { jsonBody, refusalResponse, withDealerStaff } from "@/lib/dealer/staff-route"

/**
 * Creates a payable run for a month end already passed (manage_dealers): the
 * dealer's unpaid lines due by then, each clawback with its commission, to its
 * APPROVED bank account. Another user approves it (decide_asset_finance).
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withDealerStaff(req, "manage_dealers", async ({ staff }) => {
    const result = await createPayableRun(staff, (await params).id, await jsonBody(req))
    if (result.kind === "refused") return refusalResponse(result)
    return NextResponse.json({ id: result.runId }, { status: 201 })
  })
}
