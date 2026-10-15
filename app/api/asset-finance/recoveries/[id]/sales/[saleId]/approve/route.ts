import { NextRequest } from "next/server"
import { approveSale } from "@/lib/asset-finance/recovery-sale"
import { recoveryWrite } from "@/lib/asset-finance/recovery-sale-route"

/** A second person approves a sale under the valuation or to a screened party. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string; saleId: string }> }) {
  return recoveryWrite(req, { permission: "decide_asset_finance", denied: "Approving a sale needs decide_asset_finance", notFound: "Sale not found" }, async (actor) => {
    const { id, saleId } = await params
    return approveSale(actor, id, saleId)
  })
}
