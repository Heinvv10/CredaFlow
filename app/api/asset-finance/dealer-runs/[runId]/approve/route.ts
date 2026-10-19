import { NextRequest, NextResponse } from "next/server"
import { approvePayableRun } from "@/lib/dealer/payable-runs"
import { refusalResponse, withDealerStaff } from "@/lib/dealer/staff-route"

/** Approves a pending payable run (decide_asset_finance); never its creator (403; also CHECK DealerPayableRun_four_eyes). */
export async function POST(req: NextRequest, { params }: { params: Promise<{ runId: string }> }) {
  return withDealerStaff(req, "decide_asset_finance", async ({ staff }) => {
    const result = await approvePayableRun(staff, (await params).runId)
    if (result.kind === "refused") return refusalResponse(result)
    if (result.kind === "self_approval") {
      return NextResponse.json({ error: "A payable run must be approved by someone other than its creator" }, { status: 403 })
    }
    return NextResponse.json(result)
  })
}
