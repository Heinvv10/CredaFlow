import { NextRequest } from "next/server"
import { applySaleProceeds } from "@/lib/asset-finance/recovery-proceeds"
import { recoveryWrite } from "@/lib/asset-finance/recovery-sale-route"

/** Apply the sale proceeds: one receipt on the loan, the shortfall or surplus, and the start of the charge freeze. Repeating it answers with the recorded result. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return recoveryWrite(req, { permission: "record_payment", denied: "Applying sale proceeds needs record_payment", notFound: "Recovery not found" }, async (actor) => {
    const body = await req.json().catch(() => null) as { receivedAt?: unknown } | null
    const receivedAt = body?.receivedAt === undefined ? new Date() : typeof body.receivedAt === "string" ? new Date(body.receivedAt) : null
    if (!receivedAt || !Number.isFinite(receivedAt.getTime())) return { kind: "bad_request", error: "Provide a valid receivedAt" }
    return applySaleProceeds(actor, (await params).id, { receivedAt })
  })
}
