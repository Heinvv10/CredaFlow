import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { recordedCallerIp } from "@/lib/rate-limit"
import { requireAssetFinanceEnabled } from "@/lib/asset-finance/require-enabled"
import { parseVatConfig } from "@/lib/asset-finance/settings-input"

const SELECT = { vatNumber: true, registeredName: true, address: true, updatedAt: true } as const

/**
 * The tenant's VAT vendor details (VatConfig, DESIGN D7): the supplier block
 * of every tax invoice. ADMIN (manage_settings). `null` until they are set;
 * a tax invoice cannot be issued before then (lib/vat/tax-invoice.ts).
 */
export async function GET(req: NextRequest) {
  const guard = await requireApiRole("ADMIN")
  if (guard.error) return guard.error

  return withTenantContext(req, async (tenant) => {
    const disabled = await requireAssetFinanceEnabled(tenant.id)
    if (disabled) return disabled
    return NextResponse.json(await prisma.vatConfig.findUnique({ where: { tenantId: tenant.id }, select: SELECT }))
  })
}

/**
 * Sets the VAT vendor details. Body: `{ vatNumber, registeredName, address }`;
 * the VAT number is ten digits starting with 4. Issued invoices keep the
 * details they were issued with (they are copied in and immutable). Audited
 * with the old and new values.
 */
export async function PUT(req: NextRequest) {
  const guard = await requireApiRole("ADMIN")
  if (guard.error) return guard.error

  return withTenantContext(req, async (tenant) => {
    const disabled = await requireAssetFinanceEnabled(tenant.id)
    if (disabled) return disabled
    const parsed = parseVatConfig(await req.json().catch(() => null))
    if ("errors" in parsed) return NextResponse.json({ error: "Invalid VAT details", fields: parsed.errors }, { status: 400 })
    const data = parsed.data

    const saved = await prisma.$transaction(async (tx) => {
      const prev = await tx.vatConfig.findUnique({ where: { tenantId: tenant.id }, select: { vatNumber: true, registeredName: true, address: true } })
      const row = await tx.vatConfig.upsert({
        where: { tenantId: tenant.id },
        update: data,
        create: { tenantId: tenant.id, ...data },
        select: SELECT,
      })
      await logAuditStrict({
        tenantId: tenant.id,
        userId: guard.user.id,
        userEmail: guard.user.email,
        ipAddress: recordedCallerIp(req) ?? undefined,
        action: AuditAction.VAT_CONFIG_UPDATED,
        entity: "VatConfig",
        entityId: tenant.id,
        oldValue: prev,
        newValue: { ...data },
      }, tx)
      return row
    })
    return NextResponse.json(saved)
  })
}
