import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { logAudit, AuditAction } from "@/lib/audit"
import { extractTokens } from "@/lib/documents/tokens"
import { createDraftVersion } from "@/lib/asset-finance/documents/templates/store"
import { storeResponse, templateActor } from "@/lib/asset-finance/documents/templates/route-helpers"

interface RouteParams {
  params: Promise<{ id: string }>
}

/**
 * Creates a DRAFT version of a CUSTOM template. `version` is the next
 * integer after the highest existing version for this template (starts at
 * 1). `tokensUsed` is derived from `bodyHtml` so the editor's token
 * validation and preview don't need to re-scan the HTML.
 */
export async function POST(req: NextRequest, { params }: RouteParams) {
  const guard = await requireApiRole("LOAN_ADMIN")
  if (guard.error) return guard.error

  return withTenantContext(req, async (tenant) => {
    const { id } = await params

    const template = await prisma.documentTemplate.findFirst({
      where: { id, tenantId: tenant.id, deletedAt: null },
    })
    if (!template) {
      return NextResponse.json({ error: "Not found" }, { status: 404 })
    }
    // SYSTEM lock: mirrors the PATCH/DELETE guard on the template itself —
    // SYSTEM templates are code-generated NCA/compliance docs, no versioning.
    if (template.kind === "SYSTEM") {
      return NextResponse.json({ error: "System templates are read-only" }, { status: 403 })
    }
    if (template.kind === "ASSET_FINANCE") {
      const body = (await req.json()) as { content?: unknown; notes?: string }
      return storeResponse(await createDraftVersion(templateActor(guard.user, tenant.id), id, body), 201)
    }

    const body = (await req.json()) as { bodyHtml?: string; notes?: string }
    if (!body.bodyHtml?.trim()) {
      return NextResponse.json({ error: "bodyHtml is required" }, { status: 422 })
    }

    const latest = await prisma.documentTemplateVersion.aggregate({
      where: { templateId: id },
      _max: { version: true },
    })
    const version = (latest._max.version ?? 0) + 1

    const created = await prisma.documentTemplateVersion.create({
      data: {
        templateId: id,
        version,
        bodyHtml: body.bodyHtml,
        tokensUsed: extractTokens(body.bodyHtml),
        status: "DRAFT",
        notes: body.notes?.trim() || null,
        createdById: guard.user.id,
      },
    })

    await logAudit({
      tenantId: tenant.id,
      userId: guard.user.id,
      action: AuditAction.DOCUMENT_TEMPLATE_VERSION_CREATED,
      entity: "DocumentTemplateVersion",
      entityId: created.id,
      newValue: { templateId: id, version: created.version, tokensUsed: created.tokensUsed },
    })

    return NextResponse.json(created, { status: 201 })
  })
}
