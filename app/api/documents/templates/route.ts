import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { listTemplates } from "@/lib/documents/catalogue"
import { logAudit, AuditAction } from "@/lib/audit"
import type { DocumentSigningMethod } from "@prisma/client"

export async function GET(req: NextRequest) {
  const guard = await requireApiRole("LOAN_ADMIN")
  if (guard.error) return guard.error

  return withTenantContext(req, async (tenant) => {
    const templates = await listTemplates(tenant.id)
    return NextResponse.json({ templates })
  })
}

// Mirrors the snake_case slugs used by prisma/seed-document-templates.ts.
function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
}

export async function POST(req: NextRequest) {
  const guard = await requireApiRole("LOAN_ADMIN")
  if (guard.error) return guard.error

  return withTenantContext(req, async (tenant) => {
    const body = (await req.json()) as {
      name?: string
      key?: string
      category?: string
      signingMethod?: DocumentSigningMethod
    }

    if (!body.name?.trim()) {
      return NextResponse.json({ error: "name is required" }, { status: 422 })
    }
    // "af." keys belong to the asset-finance legal templates (adopted, never created here).
    if ((body.key?.trim() || slugify(body.name)).startsWith("af.")) {
      return NextResponse.json({ error: "Keys starting with af. are reserved for asset-finance templates" }, { status: 422 })
    }

    const created = await prisma.documentTemplate.create({
      data: {
        tenantId: tenant.id,
        key: body.key?.trim() || slugify(body.name),
        name: body.name.trim(),
        category: body.category?.trim() || null,
        kind: "CUSTOM",
        signingMethod: body.signingMethod ?? "NONE",
      },
    })

    await logAudit({
      tenantId: tenant.id,
      userId: guard.user.id,
      action: AuditAction.DOCUMENT_TEMPLATE_CREATED,
      entity: "DocumentTemplate",
      entityId: created.id,
      newValue: { name: created.name, key: created.key, kind: created.kind, category: created.category },
    })

    return NextResponse.json(created, { status: 201 })
  })
}
