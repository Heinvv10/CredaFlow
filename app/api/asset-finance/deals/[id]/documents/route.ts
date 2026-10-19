import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { requireAssetFinanceEnabled } from "@/lib/asset-finance/require-enabled"
import { DEAL_EVIDENCE_DOC_TYPES } from "@/lib/asset-finance/payout-checklist"
import { parseEntityDocumentForm, storeDealEvidenceDocument } from "@/lib/asset-finance/entity-document-io"

type Params = { params: Promise<{ id: string }> }

/** Staff upload payout evidence directly against an entity or natural deal. */
export async function POST(req: NextRequest, { params }: Params) {
  const guard = await requireApiRole("CREDIT_OFFICER")
  if (guard.error) return guard.error
  return withTenantContext(req, async (tenant) => {
    const disabled = await requireAssetFinanceEnabled(tenant.id)
    if (disabled) return disabled
    const { id } = await params
    const deal = await prisma.assetFinanceDeal.findFirst({
      where: { id, tenantId: tenant.id }, select: { id: true, entityId: true, clientId: true },
    })
    if (!deal) return NextResponse.json({ error: "Deal not found" }, { status: 404 })
    const parsed = await parseEntityDocumentForm(req, DEAL_EVIDENCE_DOC_TYPES, { allowDeal: false })
    if ("error" in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 })
    const document = await storeDealEvidenceDocument({
      tenantId: tenant.id, dealId: deal.id, entityId: deal.entityId, clientId: deal.clientId,
      upload: { ...parsed.upload, dealId: deal.id },
      uploader: { type: "staff", id: guard.user.id, email: guard.user.email },
    })
    return NextResponse.json(document, { status: 201 })
  })
}
