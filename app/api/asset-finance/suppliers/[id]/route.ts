import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { canDo, requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { requireAssetFinanceEnabled } from "@/lib/asset-finance/require-enabled"
import { parseSupplierUpdate } from "@/lib/asset-finance/supplier-input"

type Params = { params: Promise<{ id: string }> }

/** One supplier with its bank accounts, newest first. */
export async function GET(req: NextRequest, { params }: Params) {
  const guard = await requireApiRole("READONLY")
  if (guard.error) return guard.error

  return withTenantContext(req, async (tenant) => {
    const disabled = await requireAssetFinanceEnabled(tenant.id)
    if (disabled) return disabled
    const { id } = await params
    const supplier = await prisma.supplier.findFirst({
      where: { id, tenantId: tenant.id },
      include: { bankAccounts: { orderBy: { createdAt: "desc" } } },
    })
    if (!supplier) return NextResponse.json({ error: "Supplier not found" }, { status: 404 })
    return NextResponse.json(supplier)
  })
}

/** Edits a supplier's details or deactivates it. Bank accounts change only through a request and approval. */
export async function PATCH(req: NextRequest, { params }: Params) {
  const guard = await requireApiRole("READONLY")
  if (guard.error) return guard.error

  return withTenantContext(req, async (tenant) => {
    const disabled = await requireAssetFinanceEnabled(tenant.id)
    if (disabled) return disabled
    if (!canDo(guard.user.role, "manage_asset_finance")) {
      return NextResponse.json({ error: "Editing a supplier needs the manage_asset_finance permission" }, { status: 403 })
    }
    const { id } = await params
    const parsed = parseSupplierUpdate(await req.json().catch(() => null))
    if ("errors" in parsed) return NextResponse.json({ error: "Invalid supplier", fields: parsed.errors }, { status: 400 })
    const changes = parsed.data

    const updated = await prisma.$transaction(async (tx) => {
      const before = await tx.supplier.findFirst({ where: { id, tenantId: tenant.id } })
      if (!before) return null
      const row = await tx.supplier.update({ where: { id }, data: changes })
      const oldValue: Record<string, unknown> = {}
      for (const key of Object.keys(changes)) oldValue[key] = before[key as keyof typeof before]
      await logAuditStrict({
        tenantId: tenant.id,
        userId: guard.user.id,
        userEmail: guard.user.email,
        action: AuditAction.SUPPLIER_UPDATED,
        entity: "Supplier",
        entityId: id,
        oldValue,
        newValue: { ...changes },
      }, tx)
      return row
    })
    if (!updated) return NextResponse.json({ error: "Supplier not found" }, { status: 404 })
    return NextResponse.json(updated)
  })
}
