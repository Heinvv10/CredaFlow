import { NextRequest, NextResponse } from "next/server"
import { Prisma } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { logAudit, AuditAction } from "@/lib/audit"

interface RouteParams {
  params: Promise<{ id: string; versionId: string }>
}

/**
 * Activates a version: sets it ACTIVE, archives whichever other version of
 * this template is currently ACTIVE, and repoints
 * `template.currentVersionId` — all inside one transaction so a document
 * generated mid-publish never sees two ACTIVE versions or a dangling
 * pointer. Gated on approval when the template requires it (dual-control:
 * see the approve route for the author≠approver rule).
 */
export async function POST(req: NextRequest, { params }: RouteParams) {
  const guard = await requireApiRole("LOAN_ADMIN")
  if (guard.error) return guard.error

  return withTenantContext(req, async (tenant) => {
    const { id, versionId } = await params

    const template = await prisma.documentTemplate.findFirst({
      where: { id, tenantId: tenant.id, deletedAt: null },
    })
    if (!template) {
      return NextResponse.json({ error: "Not found" }, { status: 404 })
    }
    if (template.kind === "SYSTEM") {
      return NextResponse.json({ error: "System templates are read-only" }, { status: 403 })
    }

    const version = await prisma.documentTemplateVersion.findFirst({
      where: { id: versionId, templateId: id },
    })
    if (!version) {
      return NextResponse.json({ error: "Not found" }, { status: 404 })
    }

    if (template.requiresApproval && !version.approvedById) {
      return NextResponse.json(
        { error: "This version requires approval by a second admin before it can be published" },
        { status: 409 }
      )
    }
    if (template.requiresApproval && version.approvedById === guard.user.id) {
      return NextResponse.json(
        { error: "The approver cannot also publish; a different admin must publish" },
        { status: 409 }
      )
    }

    // Queried before the transaction so we know exactly which version(s) got
    // archived for the audit trail below — updateMany's return value is only
    // a count.
    const previouslyActive = await prisma.documentTemplateVersion.findMany({
      where: { templateId: id, status: "ACTIVE", id: { not: versionId } },
    })

    const activatedAt = new Date()

    const activated = await prisma.$transaction(async (tx) => {
      // Serialize concurrent publishes on this template: without this lock,
      // two overlapping publish calls under READ COMMITTED can each
      // archive-then-activate a different version and both end up ACTIVE.
      await tx.$queryRaw(Prisma.sql`SELECT 1 FROM "DocumentTemplate" WHERE id = ${id} FOR UPDATE`)

      await tx.documentTemplateVersion.updateMany({
        where: { templateId: id, status: "ACTIVE", id: { not: versionId } },
        data: { status: "ARCHIVED" },
      })
      const updated = await tx.documentTemplateVersion.update({
        where: { id: versionId },
        data: { status: "ACTIVE", activatedById: guard.user.id, activatedAt },
      })
      await tx.documentTemplate.update({
        where: { id },
        data: { currentVersionId: versionId },
      })
      return updated
    })

    for (const prev of previouslyActive) {
      await logAudit({
        tenantId: tenant.id,
        userId: guard.user.id,
        action: AuditAction.DOCUMENT_TEMPLATE_VERSION_ARCHIVED,
        entity: "DocumentTemplateVersion",
        entityId: prev.id,
        oldValue: { status: "ACTIVE" },
        newValue: { status: "ARCHIVED" },
      })
    }

    await logAudit({
      tenantId: tenant.id,
      userId: guard.user.id,
      action: AuditAction.DOCUMENT_TEMPLATE_VERSION_PUBLISHED,
      entity: "DocumentTemplateVersion",
      entityId: versionId,
      newValue: { templateId: id, version: version.version },
    })

    return NextResponse.json(activated)
  })
}
