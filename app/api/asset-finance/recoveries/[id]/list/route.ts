import { NextRequest } from "next/server"
import { recoveryResponse, withRecoveryStaff } from "@/lib/asset-finance/recovery-route"
import { listForSale } from "@/lib/asset-finance/recovery-store"

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withRecoveryStaff(req, "manage_asset_finance", async (actor) => {
    const { id } = await params
    return recoveryResponse(await listForSale(actor, id))
  })
}
