import { NextRequest } from "next/server"
import { releaseRefund } from "@/lib/asset-finance/recovery-refund"
import { recoveryWrite } from "@/lib/asset-finance/recovery-sale-route"

/** Release the approved refund; the recovery closes with it. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return recoveryWrite(req, { permission: "decide_asset_finance", denied: "Releasing a refund needs decide_asset_finance", notFound: "Refund not found" }, async (actor) =>
    releaseRefund(actor, (await params).id))
}
