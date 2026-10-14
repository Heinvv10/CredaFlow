import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { requireAssetFinanceEnabled } from "@/lib/asset-finance/require-enabled"
import { STAFF_UPLOAD_DOC_TYPES } from "@/lib/asset-finance/entity-documents"
import { parseEntityDocumentForm, storeEntityDocument } from "@/lib/asset-finance/entity-document-io"
import { loadEntityDocuments } from "@/lib/asset-finance/entity-detail"

type Params = { params: Promise<{ id: string }> }

/** The entity's live documents: metadata only, so no access-log row. */
export async function GET(req: NextRequest, { params }: Params) {
  const guard = await requireApiRole("READONLY")
  if (guard.error) return guard.error

  return withTenantContext(req, async (tenant) => {
    const disabled = await requireAssetFinanceEnabled(tenant.id)
    if (disabled) return disabled
    const { id } = await params
    const entity = await prisma.businessEntity.findFirst({ where: { id, tenantId: tenant.id }, select: { id: true } })
    if (!entity) return NextResponse.json({ error: "Entity not found" }, { status: 404 })
    return NextResponse.json(await loadEntityDocuments(tenant.id, id))
  })
}

/** Upload a document for the entity (multipart: file, docType, dealId?). */
export async function POST(req: NextRequest, { params }: Params) {
  // manage_asset_finance
  const guard = await requireApiRole("CREDIT_OFFICER")
  if (guard.error) return guard.error

  return withTenantContext(req, async (tenant) => {
    const disabled = await requireAssetFinanceEnabled(tenant.id)
    if (disabled) return disabled
    const { id } = await params
    const entity = await prisma.businessEntity.findFirst({ where: { id, tenantId: tenant.id }, select: { id: true } })
    if (!entity) return NextResponse.json({ error: "Entity not found" }, { status: 404 })

    const parsed = await parseEntityDocumentForm(req, STAFF_UPLOAD_DOC_TYPES, { allowDeal: true })
    if ("error" in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 })
    if (parsed.upload.dealId) {
      const deal = await prisma.assetFinanceDeal.findFirst({
        where: { id: parsed.upload.dealId, entityId: id, tenantId: tenant.id },
        select: { id: true },
      })
      if (!deal) return NextResponse.json({ error: "dealId is not a deal of this entity" }, { status: 400 })
    }

    const document = await storeEntityDocument({
      tenantId: tenant.id,
      entityId: id,
      upload: parsed.upload,
      uploader: { type: "staff", id: guard.user.id, email: guard.user.email },
    })
    return NextResponse.json(document, { status: 201 })
  })
}
