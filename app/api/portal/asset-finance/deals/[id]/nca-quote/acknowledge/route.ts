import { NextRequest, NextResponse } from "next/server"
import { isSha256Digest } from "@/lib/documents/content-integrity"
import { withPortalEntity } from "@/lib/asset-finance/portal-route"
import { acknowledgeAssetEntityNcaQuote } from "@/lib/asset-finance/nca-quote-store"

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return withPortalEntity(req, null, async ({ tenantId, client }) => {
    const body = await req.json().catch(() => null) as { documentSha256?: unknown } | null
    if (!isSha256Digest(body?.documentSha256)) return NextResponse.json({ error: "documentSha256 must identify the quotation shown" }, { status: 400 })
    const result = await acknowledgeAssetEntityNcaQuote({
      tenantId, clientId: client.clientId, clientEmail: client.email, dealId: id, documentSha256: body.documentSha256,
    })
    if (result.kind === "not_found") return NextResponse.json({ error: "Not found" }, { status: 404 })
    if (result.kind === "not_ready") return NextResponse.json({ error: result.reason }, { status: 409 })
    return NextResponse.json(result)
  })
}
