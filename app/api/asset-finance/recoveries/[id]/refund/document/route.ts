import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { serveEntityDocument } from "@/lib/asset-finance/entity-document-io"
import { withRecoveryStaff } from "@/lib/asset-finance/recovery-route"

/** The refund's bank-verification document, served to staff who manage the refund; every view or download is access-logged. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withRecoveryStaff(req, "manage_asset_finance", async (actor) => {
    const { id } = await params
    const refund = await prisma.recoveryRefund.findFirst({
      where: { recoveryId: id, tenantId: actor.tenantId, bankVerificationDocument: { deletedAt: null } },
      select: { bankVerificationDocument: { select: { id: true, fileName: true, mimeType: true, storagePath: true, contentSha256: true } } },
    })
    if (!refund) return NextResponse.json({ error: "Document not found" }, { status: 404 })
    return serveEntityDocument(req, refund.bankVerificationDocument, { type: "staff", id: actor.userId })
  })
}
