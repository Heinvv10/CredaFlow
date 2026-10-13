import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { canDo, requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { requireAssetFinanceEnabled } from "@/lib/asset-finance/require-enabled"
import { parseBankAccountRequest } from "@/lib/asset-finance/supplier-input"

type Params = { params: Promise<{ id: string }> }

/** A supplier's bank accounts, newest first. */
export async function GET(req: NextRequest, { params }: Params) {
  const guard = await requireApiRole("READONLY")
  if (guard.error) return guard.error

  return withTenantContext(req, async (tenant) => {
    const disabled = await requireAssetFinanceEnabled(tenant.id)
    if (disabled) return disabled
    const { id } = await params
    const supplier = await prisma.supplier.findFirst({ where: { id, tenantId: tenant.id }, select: { id: true } })
    if (!supplier) return NextResponse.json({ error: "Supplier not found" }, { status: 404 })
    const accounts = await prisma.supplierBankAccount.findMany({
      where: { tenantId: tenant.id, supplierId: id },
      orderBy: { createdAt: "desc" },
    })
    return NextResponse.json(accounts)
  })
}

/**
 * Requests a new bank account for a supplier (a first account or a change).
 * It is created PENDING (the database refuses anything else) and cannot be
 * paid into until a different user with decide_asset_finance approves it at
 * /api/asset-finance/suppliers/bank-accounts/[accountId]/decide.
 */
export async function POST(req: NextRequest, { params }: Params) {
  const guard = await requireApiRole("READONLY")
  if (guard.error) return guard.error

  return withTenantContext(req, async (tenant) => {
    const disabled = await requireAssetFinanceEnabled(tenant.id)
    if (disabled) return disabled
    if (!canDo(guard.user.role, "manage_asset_finance")) {
      return NextResponse.json({ error: "Requesting a supplier bank account needs the manage_asset_finance permission" }, { status: 403 })
    }
    const { id } = await params
    const parsed = parseBankAccountRequest(await req.json().catch(() => null))
    if ("errors" in parsed) return NextResponse.json({ error: "Invalid bank account", fields: parsed.errors }, { status: 400 })
    const data = parsed.data

    const supplier = await prisma.supplier.findFirst({ where: { id, tenantId: tenant.id }, select: { active: true } })
    if (!supplier) return NextResponse.json({ error: "Supplier not found" }, { status: 404 })
    if (!supplier.active) return NextResponse.json({ error: "The supplier is inactive" }, { status: 409 })

    const account = await prisma.$transaction(async (tx) => {
      const row = await tx.supplierBankAccount.create({
        data: { ...data, tenantId: tenant.id, supplierId: id, status: "PENDING", requestedById: guard.user.id },
      })
      await logAuditStrict({
        tenantId: tenant.id,
        userId: guard.user.id,
        userEmail: guard.user.email,
        action: AuditAction.SUPPLIER_BANK_ACCOUNT_REQUESTED,
        entity: "SupplierBankAccount",
        entityId: row.id,
        newValue: {
          supplierId: id,
          bankName: data.bankName,
          branchCode: data.branchCode,
          accountNumberLast4: data.accountNumber.slice(-4),
          accountHolder: data.accountHolder,
          accountType: data.accountType,
        },
      }, tx)
      return row
    })
    return NextResponse.json(account, { status: 201 })
  })
}
