import { NextRequest } from "next/server"
import { invalidBody, recoveryResponse, withRecoveryStaff } from "@/lib/asset-finance/recovery-route"
import { withdrawRecovery } from "@/lib/asset-finance/recovery-store"

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withRecoveryStaff(req, "manage_asset_finance", async (actor) => {
    const body = await req.json().catch(() => null) as { reason?: unknown } | null
    if (typeof body?.reason !== "string") return invalidBody({ reason: "is required" })
    const { id } = await params
    return recoveryResponse(await withdrawRecovery(actor, id, body.reason))
  })
}
