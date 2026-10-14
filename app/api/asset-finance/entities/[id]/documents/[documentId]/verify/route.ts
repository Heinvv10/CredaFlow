import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { requireAssetFinanceEnabled } from "@/lib/asset-finance/require-enabled"
import { ENTITY_DOCUMENT_VIEW_SELECT, toEntityDocumentView } from "@/lib/asset-finance/entity-documents"

type Params = { params: Promise<{ id: string; documentId: string }> }

/**
 * Mark the document verified: a staff member has checked it is what it says.
 * Only verified documents count as classifier evidence. Verifying twice
 * answers 409 and keeps the first verifier.
 */
export async function POST(req: NextRequest, { params }: Params) {
  // manage_asset_finance
  const guard = await requireApiRole("CREDIT_OFFICER")
  if (guard.error) return guard.error

  return withTenantContext(req, async (tenant) => {
    const disabled = await requireAssetFinanceEnabled(tenant.id)
    if (disabled) return disabled
    const { id, documentId } = await params

    const outcome = await prisma.$transaction(async (tx) => {
      const doc = await tx.entityDocument.findFirst({
        where: { id: documentId, entityId: id, tenantId: tenant.id, deletedAt: null },
        select: { id: true, docType: true, verifiedAt: true },
      })
      if (!doc) return { kind: "not_found" as const }
      if (doc.verifiedAt) return { kind: "already" as const }
      const verifiedAt = new Date()
      // Pinned on the unverified, live state: concurrent verifies write once.
      const { count } = await tx.entityDocument.updateMany({
        where: { id: doc.id, tenantId: tenant.id, verifiedAt: null, deletedAt: null },
        data: { verifiedAt, verifiedById: guard.user.id },
      })
      if (count === 0) return { kind: "already" as const }
      await logAuditStrict(
        {
          tenantId: tenant.id,
          userId: guard.user.id,
          userEmail: guard.user.email,
          action: AuditAction.ENTITY_DOCUMENT_VERIFIED,
          entity: "EntityDocument",
          entityId: doc.id,
          newValue: { businessEntityId: id, docType: doc.docType, verifiedAt: verifiedAt.toISOString() },
        },
        tx,
      )
      const row = await tx.entityDocument.findFirstOrThrow({
        where: { id: doc.id, tenantId: tenant.id },
        select: ENTITY_DOCUMENT_VIEW_SELECT,
      })
      return { kind: "verified" as const, row }
    })
    if (outcome.kind === "not_found") return NextResponse.json({ error: "Document not found" }, { status: 404 })
    if (outcome.kind === "already") return NextResponse.json({ error: "The document is already verified" }, { status: 409 })
    return NextResponse.json(toEntityDocumentView(outcome.row))
  })
}
