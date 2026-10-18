import { canDo, requireApiRole } from "@/lib/auth-guards"
import { NextResponse } from "next/server"
import { NextRequest } from "next/server"
import { applySaleProceeds } from "@/lib/asset-finance/recovery-proceeds"
import { recoveryWrite } from "@/lib/asset-finance/recovery-sale-route"

/** Apply the sale proceeds: one receipt on the loan, the shortfall or surplus, and the start of the charge freeze. Repeating it answers with the recorded result. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const body = await req.json().catch(() => null) as { receivedAt?: unknown; assessment?: unknown } | null
  if (body?.assessment !== undefined) {
    const decision = await requireApiRole("READONLY")
    if (decision.error) return decision.error
    if (!canDo(decision.user.role, "decide_asset_finance")) return NextResponse.json({ error: "Approving the cancellation assessment needs decide_asset_finance" }, { status: 403 })
  }
  return recoveryWrite(req, { permission: "record_payment", denied: "Applying sale proceeds needs record_payment", notFound: "Recovery not found" }, async (actor) => {
    if (body && body.receivedAt !== undefined) return { kind: "bad_request", error: "Proceeds are applied as of now; a receipt date cannot be set" }
    return applySaleProceeds(actor, (await params).id, body?.assessment)
  })
}
