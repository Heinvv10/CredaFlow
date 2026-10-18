import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { logAudit, AuditAction } from "@/lib/audit"
import { approveVersion } from "@/lib/asset-finance/documents/templates/store"
import { storeResponse, templateActor } from "@/lib/asset-finance/documents/templates/route-helpers"

interface RouteParams {
  params: Promise<{ id: string; versionId: string }>
}

/**
 * Dual-control approval step: a second LOAN_ADMIN signs off on a draft
 * before it can be published. `DocumentTemplateVersion` has no `tenantId`
 * column of its own (see lib/tenant-scope.ts) — tenant scoping is enforced
 * by loading the parent template first and then filtering the version by
 * that verified `templateId`.
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
    // Lender legal wording: exact-content approval, TOTP and basis (lib/asset-finance/documents/templates/store.ts).
    if (template.kind === "ASSET_FINANCE") {
      const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
      return storeResponse(await approveVersion(templateActor(guard.user, tenant.id), id, versionId, body))
    }

    const version = await prisma.documentTemplateVersion.findFirst({
      where: { id: versionId, templateId: id },
    })
    if (!version) {
      return NextResponse.json({ error: "Not found" }, { status: 404 })
    }

    // Separation of duties: the author of a draft cannot also be its approver.
    if (version.createdById === guard.user.id) {
      return NextResponse.json(
        { error: "Cannot approve your own draft" },
        { status: 409 }
      )
    }

    const approved = await prisma.documentTemplateVersion.update({
      where: { id: versionId },
      data: { approvedById: guard.user.id, approvedAt: new Date() },
    })

    await logAudit({
      tenantId: tenant.id,
      userId: guard.user.id,
      action: AuditAction.DOCUMENT_TEMPLATE_VERSION_APPROVED,
      entity: "DocumentTemplateVersion",
      entityId: versionId,
      oldValue: { approvedById: version.approvedById },
      newValue: { templateId: id, approvedById: guard.user.id },
    })

    return NextResponse.json(approved)
  })
}
