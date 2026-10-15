import { NextRequest } from "next/server"
import { decideRecoveryCost } from "@/lib/asset-finance/recovery-costs"
import { parseCostDecision } from "@/lib/asset-finance/recovery-input"
import { invalidBody, recoveryResponse, withRecoveryStaff } from "@/lib/asset-finance/recovery-route"

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string; costId: string }> }) {
  return withRecoveryStaff(req, "decide_asset_finance", async (actor) => {
    const parsed = parseCostDecision(await req.json().catch(() => null))
    if ("errors" in parsed) return invalidBody(parsed.errors)
    const { id, costId } = await params
    return recoveryResponse(await decideRecoveryCost(actor, id, costId, parsed.data.decision), "Cost not found")
  })
}
