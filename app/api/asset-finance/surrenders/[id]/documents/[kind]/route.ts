import { NextRequest, NextResponse } from "next/server"
import { requireApiRole } from "@/lib/auth-guards"
import { logDocumentAccess } from "@/lib/document-auth"
import { prisma } from "@/lib/prisma"
import { withTenantContext } from "@/lib/tenant"
import { requireAssetFinanceEnabled } from "@/lib/asset-finance/require-enabled"
import { readSurrenderNotice } from "@/lib/asset-finance/surrender-store"

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string; kind: string }> }) {
  const guard = await requireApiRole("READONLY")
  if (guard.error) return guard.error
  return withTenantContext(req, async (tenant) => {
    const disabled = await requireAssetFinanceEnabled(tenant.id)
    if (disabled) return disabled
    const { id, kind } = await params
    if (kind !== "valuation" && kind !== "final") return NextResponse.json({ error: "Document not found" }, { status: 404 })
    const document = await readSurrenderNotice(tenant.id, id, kind)
    if (!document) return NextResponse.json({ error: "Document not found" }, { status: 404 })
    const isDownload = new URL(req.url).searchParams.get("download") === "1"
    await logDocumentAccess(prisma, { documentId: `${id}:${kind}`, accessorType: "staff", accessorId: guard.user.id, action: isDownload ? "download" : "view", req })
    return pdf(document.bytes, id, kind, isDownload)
  })
}

function pdf(bytes: Buffer, id: string, kind: string, download: boolean): Response {
  return new Response(new Uint8Array(bytes), { headers: {
    "Content-Type": "application/pdf", "Content-Length": String(bytes.length), "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff", "Content-Disposition": `${download ? "attachment" : "inline"}; filename="surrender-${kind}-${id}.pdf"`,
  } })
}
