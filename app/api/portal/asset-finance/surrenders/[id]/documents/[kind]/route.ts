import { NextRequest, NextResponse } from "next/server"
import { logDocumentAccess } from "@/lib/document-auth"
import { prisma } from "@/lib/prisma"
import { withPortalEntity } from "@/lib/asset-finance/portal-route"
import { clientSurrenderAccess, readSurrenderNotice } from "@/lib/asset-finance/surrender-store"

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string; kind: string }> }) {
  const { id, kind } = await params
  return withPortalEntity(req, null, async ({ tenantId, client }) => {
    if ((kind !== "valuation" && kind !== "final") || !(await clientSurrenderAccess(tenantId, client.clientId, id))) {
      return NextResponse.json({ error: "Not found" }, { status: 404 })
    }
    const document = await readSurrenderNotice(tenantId, id, kind)
    if (!document) return NextResponse.json({ error: "Not found" }, { status: 404 })
    const isDownload = new URL(req.url).searchParams.get("download") === "1"
    await logDocumentAccess(prisma, { documentId: `${id}:${kind}`, accessorType: "client", accessorId: client.clientId, action: isDownload ? "download" : "view", req })
    return new Response(new Uint8Array(document.bytes), { headers: {
      "Content-Type": "application/pdf", "Content-Length": String(document.bytes.length), "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff", "Content-Disposition": `${isDownload ? "attachment" : "inline"}; filename="surrender-${kind}-${id}.pdf"`,
    } })
  })
}
