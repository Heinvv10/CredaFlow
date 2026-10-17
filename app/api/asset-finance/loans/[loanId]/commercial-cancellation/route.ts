import { NextResponse } from "next/server"
import { parseCommercialCancellation, recordCommercialCancellation } from "@/lib/asset-finance/commercial-cancellation"
import { withRecoveryStaff, recoveryResponse } from "@/lib/asset-finance/recovery-route"

export async function POST(req: Request, { params }: { params: Promise<{ loanId: string }> }) {
  return withRecoveryStaff(req, "decide_asset_finance", async (actor) => {
    const { loanId } = await params
    const input = parseCommercialCancellation(await req.json().catch(() => null))
    if (typeof input === "string") return NextResponse.json({ error: input }, { status: 422 })
    return recoveryResponse(await recordCommercialCancellation(actor, loanId, input), "Agreement not found", true)
  })
}
