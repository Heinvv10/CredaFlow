import { NextRequest, NextResponse } from "next/server"
import { withPortalEntity } from "@/lib/asset-finance/portal-route"
import { requestSurrender } from "@/lib/asset-finance/surrender-store"

export async function POST(req: NextRequest, { params }: { params: Promise<{ loanId: string }> }) {
  const { loanId } = await params
  return withPortalEntity(req, null, async ({ tenantId, client }) => {
    const body = await req.json().catch(() => null) as { assetCondition?: unknown } | null
    const result = await requestSurrender({ tenantId, userId: client.clientId, userEmail: client.email }, loanId, typeof body?.assetCondition === "string" ? body.assetCondition : "", "CLIENT")
    if (result.kind === "not_found") return NextResponse.json({ error: "Not found" }, { status: 404 })
    if (result.kind === "not_ready") return NextResponse.json({ error: result.reason }, { status: 422 })
    return NextResponse.json(result, { status: 201 })
  })
}
