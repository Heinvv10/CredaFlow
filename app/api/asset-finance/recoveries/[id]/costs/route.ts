import { NextRequest } from "next/server"
import { recordRecoveryCost } from "@/lib/asset-finance/recovery-costs"
import { parseCost } from "@/lib/asset-finance/recovery-input"
import { invalidBody, recoveryResponse, withRecoveryStaff } from "@/lib/asset-finance/recovery-route"

// The approver (decide_asset_finance) records the cost and names who captured the invoice: see recordRecoveryCost.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withRecoveryStaff(req, "decide_asset_finance", async (actor) => {
    const parsed = parseCost(await req.json().catch(() => null))
    if ("errors" in parsed) return invalidBody(parsed.errors)
    const { id } = await params
    return recoveryResponse(await recordRecoveryCost(actor, id, parsed.data), "Recovery, supplier or recorder not found", true)
  })
}
