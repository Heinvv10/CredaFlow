import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { canDo, requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { requireAssetFinanceEnabled } from "@/lib/asset-finance/require-enabled"
import { parseAssetCreate } from "@/lib/asset-finance/asset-input"
import { createFinancedAsset } from "@/lib/asset-finance/asset-create"

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
 * asset in this tenant, as either, is refused by the database (DESIGN D8,
 * book-wide duplicate check, on the normalised identifiers); the route
 * answers 409 and audits the attempt. The VAT must be the VAT on the
 * exclusive cash price at the rate in force today (400 otherwise; the
 * database checks it too).
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
    const created = await createFinancedAsset(
      { kind: "staff", tenantId: tenant.id, userId: guard.user.id, userEmail: guard.user.email },
      parsed.data,
    )
    if (created.kind === "invalid") return NextResponse.json({ error: "Invalid asset", fields: created.fields }, { status: 400 })
    if (created.kind === "duplicate") return NextResponse.json({ error: created.message }, { status: 409 })
    return NextResponse.json(created.asset, { status: 201 })
  })
}
