import { NextRequest } from "next/server"
import { proposeSale } from "@/lib/asset-finance/recovery-sale"
import { parseSaleInput } from "@/lib/asset-finance/recovery-sale-input"
import { recoveryWrite } from "@/lib/asset-finance/recovery-sale-route"

/** Propose a remarketing sale of a listed recovery (screened for related parties; approval where needed). */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return recoveryWrite(req, { permission: "manage_asset_finance", denied: "Proposing a sale needs manage_asset_finance", notFound: "Recovery not found", success: 201 }, async (actor) => {
    const parsed = parseSaleInput(await req.json().catch(() => null))
    if (!parsed.ok) return { kind: "bad_request", error: parsed.error }
    return proposeSale(actor, (await params).id, parsed.value)
  })
}
