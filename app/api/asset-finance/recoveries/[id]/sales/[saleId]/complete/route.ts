import { NextRequest } from "next/server"
import { sastCalendarDate } from "@/lib/date/sast"
import { completeSale } from "@/lib/asset-finance/recovery-sale-complete"
import { recoveryWrite } from "@/lib/asset-finance/recovery-sale-route"

/** Complete the sale: the buyer's tax invoice, the VAT event and RECOVERED -> SOLD in one transaction. `completedOn` defaults to today (SAST). */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string; saleId: string }> }) {
  return recoveryWrite(req, { permission: "manage_asset_finance", denied: "Completing a sale needs manage_asset_finance", notFound: "Sale not found" }, async (actor) => {
    const body = await req.json().catch(() => null) as { completedOn?: unknown } | null
    if (body?.completedOn !== undefined && typeof body.completedOn !== "string") return { kind: "bad_request", error: "completedOn must be YYYY-MM-DD" }
    const { id, saleId } = await params
    return completeSale(actor, id, saleId, { completedOn: body?.completedOn ?? sastCalendarDate(new Date()) })
  })
}
