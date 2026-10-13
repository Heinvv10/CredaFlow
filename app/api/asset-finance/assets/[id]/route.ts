import { NextRequest, NextResponse } from "next/server"
import { Prisma } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { canDo, requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { auditRefusal } from "@/lib/audit-refusals"
import { requireAssetFinanceEnabled } from "@/lib/asset-finance/require-enabled"
import { CONTRACT_FIELDS, duplicateAssetMessage, parseAssetUpdate } from "@/lib/asset-finance/asset-input"

type Params = { params: Promise<{ id: string }> }

/** One asset with its valuations (newest first) and the deals it is on. */
export async function GET(req: NextRequest, { params }: Params) {
  const guard = await requireApiRole("READONLY")
  if (guard.error) return guard.error

  return withTenantContext(req, async (tenant) => {
    const disabled = await requireAssetFinanceEnabled(tenant.id)
    if (disabled) return disabled
    const { id } = await params
    const asset = await prisma.financedAsset.findFirst({
      where: { id, tenantId: tenant.id },
      include: {
        valuations: { orderBy: [{ valuedOn: "desc" }, { createdAt: "desc" }] },
        deals: { select: { id: true, status: true, loanId: true } },
      },
    })
    if (!asset) return NextResponse.json({ error: "Asset not found" }, { status: 404 })
    return NextResponse.json(asset)
  })
}

/**
 * Edits an asset. Its identity and price (CONTRACT_FIELDS) are frozen once it
 * is on a booked loan; a released asset is history and is not edited. The row
 * is locked so a concurrent booking sees the edit or the edit sees the loan.
 */
export async function PATCH(req: NextRequest, { params }: Params) {
  const guard = await requireApiRole("READONLY")
  if (guard.error) return guard.error

  return withTenantContext(req, async (tenant) => {
    const disabled = await requireAssetFinanceEnabled(tenant.id)
    if (disabled) return disabled
    if (!canDo(guard.user.role, "manage_asset_finance")) {
      return NextResponse.json({ error: "Editing an asset needs the manage_asset_finance permission" }, { status: 403 })
    }
    const { id } = await params
    const parsed = parseAssetUpdate(await req.json().catch(() => null))
    if ("errors" in parsed) return NextResponse.json({ error: "Invalid asset", fields: parsed.errors }, { status: 400 })
    const changes = parsed.data

    try {
      const result = await prisma.$transaction(async (tx) => {
        const locked = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          SELECT "id" FROM "FinancedAsset" WHERE "id" = ${id} AND "tenantId" = ${tenant.id} FOR UPDATE
        `)
        if (!locked[0]) return { kind: "not_found" as const }
        const before = await tx.financedAsset.findFirst({
          where: { id, tenantId: tenant.id },
          include: { _count: { select: { loans: true } } },
        })
        if (!before) return { kind: "not_found" as const }
        if (before.releasedAt) return { kind: "released" as const }
        const contractChanges = CONTRACT_FIELDS.filter((key) => key in changes)
        if (before._count.loans > 0 && contractChanges.length > 0) {
          return { kind: "booked" as const, fields: contractChanges }
        }
        const residual = changes.residualCents !== undefined ? changes.residualCents : before.residualCents
        const total = (changes.cashPriceExclVatCents ?? before.cashPriceExclVatCents) + (changes.vatCents ?? before.vatCents)
        if (residual !== null && residual > total) return { kind: "residual" as const }

        const updated = await tx.financedAsset.update({ where: { id }, data: changes })
        const oldValue: Record<string, unknown> = {}
        for (const key of Object.keys(changes)) oldValue[key] = before[key as keyof typeof before]
        await logAuditStrict({
          tenantId: tenant.id,
          userId: guard.user.id,
          userEmail: guard.user.email,
          action: AuditAction.ASSET_UPDATED,
          entity: "FinancedAsset",
          entityId: id,
          oldValue,
          newValue: { ...changes },
        }, tx)
        return { kind: "updated" as const, asset: updated }
      })

      switch (result.kind) {
        case "not_found":
          return NextResponse.json({ error: "Asset not found" }, { status: 404 })
        case "released":
          return NextResponse.json({ error: "A released asset is no longer edited" }, { status: 409 })
        case "booked":
          return NextResponse.json(
            { error: `The asset is on a booked loan; ${result.fields.join(", ")} can no longer change` },
            { status: 409 },
          )
        case "residual":
          return NextResponse.json(
            { error: "Invalid asset", fields: { residualCents: "cannot exceed the cash price including VAT" } },
            { status: 400 },
          )
        case "updated":
          return NextResponse.json(result.asset)
      }
    } catch (error) {
      const duplicate = duplicateAssetMessage(error)
      if (!duplicate) throw error
      await auditRefusal({
        action: AuditAction.ASSET_DUPLICATE_REFUSED,
        entity: "FinancedAsset",
        entityId: id,
        tenantId: tenant.id,
        userId: guard.user.id,
        userEmail: guard.user.email,
        reason: "duplicate_unreleased_asset",
        status: 409,
        detail: { serialNumber: changes.serialNumber, vin: changes.vin },
      })
      return NextResponse.json({ error: duplicate }, { status: 409 })
    }
  })
}
