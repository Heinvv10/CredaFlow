import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { requireAssetFinanceEnabled } from "@/lib/asset-finance/require-enabled"
import { serveEntityDocument } from "@/lib/asset-finance/entity-document-io"
import { lockBusinessEntity } from "@/lib/asset-finance/entity-documents"

type Params = { params: Promise<{ id: string; documentId: string }> }

/** The document's bytes (`?download=1` as an attachment). Writes a DocumentAccessLog row. */
export async function GET(req: NextRequest, { params }: Params) {
  const guard = await requireApiRole("READONLY")
  if (guard.error) return guard.error

  return withTenantContext(req, async (tenant) => {
    const disabled = await requireAssetFinanceEnabled(tenant.id)
    if (disabled) return disabled
    const { id, documentId } = await params
    const doc = await prisma.entityDocument.findFirst({
      where: { id: documentId, entityId: id, tenantId: tenant.id, deletedAt: null },
      select: { id: true, fileName: true, mimeType: true, storagePath: true, contentSha256: true },
    })
    if (!doc) return NextResponse.json({ error: "Document not found" }, { status: 404 })
    return serveEntityDocument(req, doc, { type: "staff", id: guard.user.id })
  })
}

/**
 * Soft-delete the document. If it was financials evidence it leaves the
 * entity's financialsEvidenceIds in the same transaction, so the classifier
 * never relies on a deleted document.
 */
export async function DELETE(req: NextRequest, { params }: Params) {
  // manage_asset_finance
  const guard = await requireApiRole("CREDIT_OFFICER")
  if (guard.error) return guard.error

  return withTenantContext(req, async (tenant) => {
    const disabled = await requireAssetFinanceEnabled(tenant.id)
    if (disabled) return disabled
    const { id, documentId } = await params

    const deleted = await prisma.$transaction(async (tx) => {
      if (!(await lockBusinessEntity(tx, tenant.id, id))) return false
      const { count } = await tx.entityDocument.updateMany({
        where: { id: documentId, entityId: id, tenantId: tenant.id, deletedAt: null },
        data: { deletedAt: new Date(), deletedById: guard.user.id },
      })
      if (count === 0) return false
      const entity = await tx.businessEntity.findFirst({
        where: { id, tenantId: tenant.id },
        select: { financialsEvidenceIds: true },
      })
      const wasEvidence = entity?.financialsEvidenceIds.includes(documentId) ?? false
      if (entity && wasEvidence) {
        await tx.businessEntity.update({
          where: { id, tenantId: tenant.id },
          data: { financialsEvidenceIds: entity.financialsEvidenceIds.filter((d) => d !== documentId) },
        })
      }
      await logAuditStrict(
        {
          tenantId: tenant.id,
          userId: guard.user.id,
          userEmail: guard.user.email,
          action: AuditAction.ENTITY_DOCUMENT_DELETED,
          entity: "EntityDocument",
          entityId: documentId,
          newValue: { businessEntityId: id, removedFromFinancialsEvidence: wasEvidence },
        },
        tx,
      )
      return true
    })
    if (!deleted) return NextResponse.json({ error: "Document not found" }, { status: 404 })
    return NextResponse.json({ id: documentId, deleted: true })
  })
}
