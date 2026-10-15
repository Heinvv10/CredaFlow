import { NextRequest, NextResponse } from "next/server"
import { requireApiRole } from "@/lib/auth-guards"
import { logDocumentAccess } from "@/lib/document-auth"
import { prisma } from "@/lib/prisma"
import { withTenantContext } from "@/lib/tenant"
import { requireAssetFinanceEnabled } from "@/lib/asset-finance/require-enabled"
import { readRecoveryDocument, type RecoveryDocumentKind } from "@/lib/asset-finance/recovery-notices"

const KINDS: readonly string[] = ["valuation", "final", "statement"]

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string; kind: string }> }) {
  const guard = await requireApiRole("READONLY")
  if (guard.error) return guard.error
  return withTenantContext(req, async (tenant) => {
    const disabled = await requireAssetFinanceEnabled(tenant.id)
    if (disabled) return disabled
    const { id, kind } = await params
    if (!KINDS.includes(kind)) return NextResponse.json({ error: "Document not found" }, { status: 404 })
    const document = await readRecoveryDocument(tenant.id, id, kind as RecoveryDocumentKind)
    if (!document) return NextResponse.json({ error: "Document not found" }, { status: 404 })
    const isDownload = new URL(req.url).searchParams.get("download") === "1"
    await logDocumentAccess(prisma, { documentId: `${id}:${kind}`, accessorType: "staff", accessorId: guard.user.id, action: isDownload ? "download" : "view", req })
    return new Response(new Uint8Array(document.bytes), { headers: {
      "Content-Type": "application/pdf", "Content-Length": String(document.bytes.length), "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff", "Content-Disposition": `${isDownload ? "attachment" : "inline"}; filename="recovery-${kind}-${id}.pdf"`,
    } })
  })
}
