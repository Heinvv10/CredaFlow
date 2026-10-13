import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { canDo, requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { auditRefusal } from "@/lib/audit-refusals"
import { requireAssetFinanceEnabled } from "@/lib/asset-finance/require-enabled"
import { duplicateAssetMessage, parseAssetCreate } from "@/lib/asset-finance/asset-input"

/** The tenant's asset register, newest first. */
export async function GET(req: NextRequest) {
  const guard = await requireApiRole("READONLY")
  if (guard.error) return guard.error

  return withTenantContext(req, async (tenant) => {
    const disabled = await requireAssetFinanceEnabled(tenant.id)
    if (disabled) return disabled
    const assets = await prisma.financedAsset.findMany({
      where: { tenantId: tenant.id },
      orderBy: { createdAt: "desc" },
      take: 500,
    })
    return NextResponse.json(assets)
  })
}

/**
 * Registers a financed asset. A serial number or VIN already on an unreleased
 * asset in this tenant is refused by the database (DESIGN D8, book-wide
 * duplicate check); the route answers 409 and audits the attempt.
 */
export async function POST(req: NextRequest) {
  const guard = await requireApiRole("READONLY")
  if (guard.error) return guard.error

  return withTenantContext(req, async (tenant) => {
    const disabled = await requireAssetFinanceEnabled(tenant.id)
    if (disabled) return disabled
    if (!canDo(guard.user.role, "manage_asset_finance")) {
      return NextResponse.json({ error: "Registering an asset needs the manage_asset_finance permission" }, { status: 403 })
    }

    const parsed = parseAssetCreate(await req.json().catch(() => null))
    if ("errors" in parsed) return NextResponse.json({ error: "Invalid asset", fields: parsed.errors }, { status: 400 })
    const data = parsed.data

    try {
      const asset = await prisma.$transaction(async (tx) => {
        const row = await tx.financedAsset.create({
          data: { ...data, tenantId: tenant.id, createdById: guard.user.id },
        })
        await logAuditStrict({
          tenantId: tenant.id,
          userId: guard.user.id,
          userEmail: guard.user.email,
          action: AuditAction.ASSET_CREATED,
          entity: "FinancedAsset",
          entityId: row.id,
          newValue: { ...data },
        }, tx)
        return row
      })
      return NextResponse.json(asset, { status: 201 })
    } catch (error) {
      const duplicate = duplicateAssetMessage(error)
      if (!duplicate) throw error
      await auditRefusal({
        action: AuditAction.ASSET_DUPLICATE_REFUSED,
        entity: "FinancedAsset",
        entityId: data.serialNumber,
        tenantId: tenant.id,
        userId: guard.user.id,
        userEmail: guard.user.email,
        reason: "duplicate_unreleased_asset",
        status: 409,
        detail: { serialNumber: data.serialNumber, vin: data.vin },
      })
      return NextResponse.json({ error: duplicate }, { status: 409 })
    }
  })
}
