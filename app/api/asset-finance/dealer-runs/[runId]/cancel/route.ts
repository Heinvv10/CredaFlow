import { NextRequest, NextResponse } from "next/server"
import { cancelPayableRun } from "@/lib/dealer/payable-runs"
import { refusalResponse, withDealerStaff } from "@/lib/dealer/staff-route"

/** Cancels a pending or approved run; its lines are free for a later run (decide_asset_finance). */
export async function POST(req: NextRequest, { params }: { params: Promise<{ runId: string }> }) {
  return withDealerStaff(req, "decide_asset_finance", async ({ staff }) => {
    const result = await cancelPayableRun(staff, (await params).runId)
    if (result.kind === "refused") return refusalResponse(result)
    return NextResponse.json(result)
  })
}
