import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { canDo, requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { requireAssetFinanceEnabled } from "@/lib/asset-finance/require-enabled"
import { parseSupplierCreate } from "@/lib/asset-finance/supplier-input"

/** The tenant's suppliers by name, each with how many bank accounts await a decision and whether one is approved. */
export async function GET(req: NextRequest) {
  const guard = await requireApiRole("READONLY")
  if (guard.error) return guard.error

  return withTenantContext(req, async (tenant) => {
    const disabled = await requireAssetFinanceEnabled(tenant.id)
    if (disabled) return disabled
    const suppliers = await prisma.supplier.findMany({
      where: { tenantId: tenant.id },
      orderBy: { name: "asc" },
      include: { bankAccounts: { where: { status: { in: ["PENDING", "APPROVED"] } }, select: { status: true } } },
      take: 500,
    })
    return NextResponse.json(suppliers.map(({ bankAccounts, ...supplier }) => ({
      ...supplier,
      hasApprovedAccount: bankAccounts.some((account) => account.status === "APPROVED"),
      pendingAccounts: bankAccounts.filter((account) => account.status === "PENDING").length,
    })))
  })
}

/** Registers a supplier. Its bank account is requested separately and needs a second user's approval. */
export async function POST(req: NextRequest) {
  const guard = await requireApiRole("READONLY")
  if (guard.error) return guard.error

  return withTenantContext(req, async (tenant) => {
    const disabled = await requireAssetFinanceEnabled(tenant.id)
    if (disabled) return disabled
    if (!canDo(guard.user.role, "manage_asset_finance")) {
      return NextResponse.json({ error: "Registering a supplier needs the manage_asset_finance permission" }, { status: 403 })
    }
    const parsed = parseSupplierCreate(await req.json().catch(() => null))
    if ("errors" in parsed) return NextResponse.json({ error: "Invalid supplier", fields: parsed.errors }, { status: 400 })
    const data = parsed.data

    const supplier = await prisma.$transaction(async (tx) => {
      const row = await tx.supplier.create({ data: { ...data, tenantId: tenant.id, createdById: guard.user.id } })
      await logAuditStrict({
        tenantId: tenant.id,
        userId: guard.user.id,
        userEmail: guard.user.email,
        action: AuditAction.SUPPLIER_CREATED,
        entity: "Supplier",
        entityId: row.id,
        newValue: { ...data },
      }, tx)
      return row
    })
    return NextResponse.json(supplier, { status: 201 })
  })
}
