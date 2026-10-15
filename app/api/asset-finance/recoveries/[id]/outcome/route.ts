import { NextRequest } from "next/server"
import { settleOutcome } from "@/lib/asset-finance/recovery-freeze"
import { recoveryWrite } from "@/lib/asset-finance/recovery-sale-route"

/** Open the outcome (SHORTFALL_OPEN, SURPLUS_HELD or CLOSED) once the final notice (NCA) or the proceeds (NON_NCA) have fixed the charge freeze. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return recoveryWrite(req, { permission: "manage_asset_finance", denied: "Opening the outcome needs manage_asset_finance", notFound: "Recovery not found" }, async (actor) =>
    settleOutcome(actor, (await params).id))
}
