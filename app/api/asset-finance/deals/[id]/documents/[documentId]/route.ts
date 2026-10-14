import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { requireAssetFinanceEnabled } from "@/lib/asset-finance/require-enabled"
import { serveEntityDocument } from "@/lib/asset-finance/entity-document-io"
import { isCheckViolation } from "@/lib/disbursement/guard-violation"

type Params = { params: Promise<{ id: string; documentId: string }> }
const select = { id: true, fileName: true, mimeType: true, storagePath: true, contentSha256: true } as const

export async function GET(req: NextRequest, { params }: Params) {
  const guard = await requireApiRole("READONLY")
  if (guard.error) return guard.error
  return withTenantContext(req, async (tenant) => {
    const disabled = await requireAssetFinanceEnabled(tenant.id)
    if (disabled) return disabled
    const { id, documentId } = await params
    const doc = await prisma.entityDocument.findFirst({
      where: { id: documentId, dealId: id, tenantId: tenant.id, deletedAt: null }, select,
    })
    if (!doc) return NextResponse.json({ error: "Document not found" }, { status: 404 })
    return serveEntityDocument(req, doc, { type: "staff", id: guard.user.id })
  })
}

export async function DELETE(req: NextRequest, { params }: Params) {
  const guard = await requireApiRole("CREDIT_OFFICER")
  if (guard.error) return guard.error
  return withTenantContext(req, async (tenant) => {
    const disabled = await requireAssetFinanceEnabled(tenant.id)
    if (disabled) return disabled
    const { id, documentId } = await params
    try {
      const deleted = await prisma.$transaction(async (tx) => {
        const row = await tx.entityDocument.updateMany({
          where: { id: documentId, dealId: id, tenantId: tenant.id, deletedAt: null },
          data: { deletedAt: new Date(), deletedById: guard.user.id },
        })
        if (row.count !== 1) return false
        await logAuditStrict({
          tenantId: tenant.id, userId: guard.user.id, userEmail: guard.user.email,
          action: AuditAction.ENTITY_DOCUMENT_DELETED, entity: "AssetFinanceDeal", entityId: id,
          newValue: { documentId },
        }, tx)
        return true
      })
      if (!deleted) return NextResponse.json({ error: "Document not found" }, { status: 404 })
      return NextResponse.json({ id: documentId, deleted: true })
    } catch (error) {
      if (isCheckViolation(error)) return NextResponse.json({ error: "This document is bound as deal evidence and cannot be deleted" }, { status: 409 })
      throw error
    }
  })
}
