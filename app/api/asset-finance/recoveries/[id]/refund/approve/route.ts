import { NextRequest } from "next/server"
import { approveRefund } from "@/lib/asset-finance/recovery-refund"
import { recoveryWrite } from "@/lib/asset-finance/recovery-sale-route"

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return recoveryWrite(req, { permission: "decide_asset_finance", denied: "Approving a refund needs decide_asset_finance", notFound: "Refund not found" }, async (actor) =>
    approveRefund(actor, (await params).id))
}
