import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { logAudit, AuditAction } from "@/lib/audit"
import { ASSET_TEMPLATE_FIXED } from "@/lib/asset-finance/documents/templates/route-helpers"
import type { DocumentSigningMethod } from "@prisma/client"

interface RouteParams {
  params: Promise<{ id: string }>
}

export async function GET(req: NextRequest, { params }: RouteParams) {
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

    return NextResponse.json(template)
  })
}

export async function PATCH(req: NextRequest, { params }: RouteParams) {
  const guard = await requireApiRole("LOAN_ADMIN")
  if (guard.error) return guard.error

  return withTenantContext(req, async (tenant) => {
    const { id } = await params

    const existing = await prisma.documentTemplate.findFirst({
      where: { id, tenantId: tenant.id, deletedAt: null },
    })
    if (!existing) {
      return NextResponse.json({ error: "Not found" }, { status: 404 })
    }
    // SYSTEM lock: reject before any mutation — SYSTEM templates are
    // code-generated NCA/compliance docs and must stay read-only via this API.
    if (existing.kind === "SYSTEM") {
      return NextResponse.json({ error: "System templates are read-only" }, { status: 403 })
    }
    if (existing.kind === "ASSET_FINANCE") return ASSET_TEMPLATE_FIXED

    const body = (await req.json()) as {
      name?: string
      category?: string
      signingMethod?: DocumentSigningMethod
      requiresApproval?: boolean
    }

    const updated = await prisma.documentTemplate.update({
      where: { id },
      data: {
        ...(body.name !== undefined ? { name: body.name.trim() } : {}),
        ...(body.category !== undefined ? { category: body.category?.trim() || null } : {}),
        ...(body.signingMethod !== undefined ? { signingMethod: body.signingMethod } : {}),
        ...(body.requiresApproval !== undefined ? { requiresApproval: body.requiresApproval } : {}),
      },
    })

    await logAudit({
      tenantId: tenant.id,
      userId: guard.user.id,
      action: AuditAction.DOCUMENT_TEMPLATE_UPDATED,
      entity: "DocumentTemplate",
      entityId: id,
      oldValue: {
        name: existing.name,
        category: existing.category,
        signingMethod: existing.signingMethod,
        requiresApproval: existing.requiresApproval,
      },
      newValue: {
        name: updated.name,
        category: updated.category,
        signingMethod: updated.signingMethod,
        requiresApproval: updated.requiresApproval,
      },
    })

    return NextResponse.json(updated)
  })
}

export async function DELETE(req: NextRequest, { params }: RouteParams) {
  const guard = await requireApiRole("LOAN_ADMIN")
  if (guard.error) return guard.error

  return withTenantContext(req, async (tenant) => {
    const { id } = await params

    const existing = await prisma.documentTemplate.findFirst({
      where: { id, tenantId: tenant.id, deletedAt: null },
    })
    if (!existing) {
      return NextResponse.json({ error: "Not found" }, { status: 404 })
    }
    // SYSTEM lock: reject before any mutation (see PATCH above).
    if (existing.kind === "SYSTEM") {
      return NextResponse.json({ error: "System templates are read-only" }, { status: 403 })
    }
    if (existing.kind === "ASSET_FINANCE") return ASSET_TEMPLATE_FIXED

    await prisma.documentTemplate.update({
      where: { id },
      data: { deletedAt: new Date() },
    })

    await logAudit({
      tenantId: tenant.id,
      userId: guard.user.id,
      action: AuditAction.DOCUMENT_TEMPLATE_DELETED,
      entity: "DocumentTemplate",
      entityId: id,
      oldValue: { name: existing.name, key: existing.key },
    })

    return NextResponse.json({ deleted: true })
  })
}
