import { NextRequest } from "next/server"
import { createRefund } from "@/lib/asset-finance/recovery-refund"
import { parseRefundForm } from "@/lib/asset-finance/recovery-refund-input"
import { recoveryWrite } from "@/lib/asset-finance/recovery-sale-route"

/** Create the surplus refund (multipart: account fields plus the bank verification as `file` and `docType`). */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return recoveryWrite(req, { permission: "manage_asset_finance", denied: "Creating a refund needs manage_asset_finance", notFound: "Recovery not found", success: 201 }, async (actor) => {
    const parsed = await parseRefundForm(req)
    if (!parsed.ok) return { kind: "bad_request", error: parsed.error }
    return createRefund(actor, (await params).id, parsed)
  })
}
