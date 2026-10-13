import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { canDo, requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { SAST_TIME_ZONE } from "@/lib/utils"
import { requireAssetFinanceEnabled } from "@/lib/asset-finance/require-enabled"
import { dbDate } from "@/lib/asset-finance/rates-store"
import { parseValuation } from "@/lib/asset-finance/asset-input"

type Params = { params: Promise<{ id: string }> }

const todaySast = () => new Intl.DateTimeFormat("en-CA", { timeZone: SAST_TIME_ZONE }).format(new Date())

/** An asset's valuations, newest first. */
export async function GET(req: NextRequest, { params }: Params) {
  const guard = await requireApiRole("READONLY")
  if (guard.error) return guard.error

  return withTenantContext(req, async (tenant) => {
    const disabled = await requireAssetFinanceEnabled(tenant.id)
    if (disabled) return disabled
    const { id } = await params
    const asset = await prisma.financedAsset.findFirst({ where: { id, tenantId: tenant.id }, select: { id: true } })
    if (!asset) return NextResponse.json({ error: "Asset not found" }, { status: 404 })
    const valuations = await prisma.assetValuation.findMany({
      where: { tenantId: tenant.id, assetId: id },
      orderBy: [{ valuedOn: "desc" }, { createdAt: "desc" }],
    })
    return NextResponse.json(valuations)
  })
}

/**
 * Records a dated valuation of an asset: source, valuer, amount in cents and
 * optionally the entity document holding the valuation report.
 */
export async function POST(req: NextRequest, { params }: Params) {
  const guard = await requireApiRole("READONLY")
  if (guard.error) return guard.error

  return withTenantContext(req, async (tenant) => {
    const disabled = await requireAssetFinanceEnabled(tenant.id)
    if (disabled) return disabled
    if (!canDo(guard.user.role, "manage_asset_finance")) {
      return NextResponse.json({ error: "Recording a valuation needs the manage_asset_finance permission" }, { status: 403 })
    }
    const { id } = await params
    const parsed = parseValuation(await req.json().catch(() => null), todaySast())
    if ("errors" in parsed) return NextResponse.json({ error: "Invalid valuation", fields: parsed.errors }, { status: 400 })
    const input = parsed.data

    const asset = await prisma.financedAsset.findFirst({ where: { id, tenantId: tenant.id }, select: { id: true } })
    if (!asset) return NextResponse.json({ error: "Asset not found" }, { status: 404 })
    if (input.documentId) {
      const document = await prisma.entityDocument.findFirst({
        where: { id: input.documentId, tenantId: tenant.id, deletedAt: null },
        select: { id: true },
      })
      if (!document) {
        return NextResponse.json({ error: "Invalid valuation", fields: { documentId: "is not a document on file" } }, { status: 400 })
      }
    }

    const valuation = await prisma.$transaction(async (tx) => {
      const row = await tx.assetValuation.create({
        data: {
          tenantId: tenant.id,
          assetId: id,
          valuedOn: dbDate(input.valuedOn),
          source: input.source,
          valuerName: input.valuerName,
          amountCents: input.amountCents,
          documentId: input.documentId,
          createdById: guard.user.id,
        },
      })
      await logAuditStrict({
        tenantId: tenant.id,
        userId: guard.user.id,
        userEmail: guard.user.email,
        action: AuditAction.ASSET_VALUATION_RECORDED,
        entity: "AssetValuation",
        entityId: row.id,
        newValue: { assetId: id, ...input },
      }, tx)
      return row
    })
    return NextResponse.json(valuation, { status: 201 })
  })
}
