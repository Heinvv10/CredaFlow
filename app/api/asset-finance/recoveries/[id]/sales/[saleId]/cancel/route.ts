import { NextRequest } from "next/server"
import { cancelSale } from "@/lib/asset-finance/recovery-sale"
import { recoveryWrite } from "@/lib/asset-finance/recovery-sale-route"

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string; saleId: string }> }) {
  return recoveryWrite(req, { permission: "manage_asset_finance", denied: "Cancelling a sale needs manage_asset_finance", notFound: "Sale not found" }, async (actor) => {
    const { id, saleId } = await params
    return cancelSale(actor, id, saleId)
  })
}
