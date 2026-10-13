import { NextRequest, NextResponse } from "next/server"
import { revalidateTag } from "next/cache"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { recordedCallerIp } from "@/lib/rate-limit"
import { parseAssetFinanceSettings } from "@/lib/asset-finance/settings-input"

// The tenant's asset-finance switch (TenantConfig.featureAssetFinance, DESIGN
// D9) and the payout dual-approval threshold (assetPayoutDualApprovalCents,
// D8), ADMIN only (manage_settings), each change audited. The same path as the
// IMS switch (app/api/settings/ims). Deliberately outside app/api/asset-finance:
// those routes 404 while the module is off, and this is how it is turned on.
//
// assetFinanceLegalWordingApproved is read here and never written: it is a
// Confirmation Gate set by CredaFlow once the lender's legal team approves the
// agreement wording (lib/asset-finance/settings-input.ts refuses it).

// Schema defaults (prisma/schema.prisma model TenantConfig), for a tenant with no config row.
const DEFAULTS = { featureAssetFinance: false, assetPayoutDualApprovalCents: 100_000_000, assetFinanceLegalWordingApproved: false }
const SELECT = { featureAssetFinance: true, assetPayoutDualApprovalCents: true, assetFinanceLegalWordingApproved: true } as const

export async function GET(req: NextRequest) {
  const guard = await requireApiRole("ADMIN")
  if (guard.error) return guard.error

  return withTenantContext(req, async (tenant) => {
    const config = await prisma.tenantConfig.findUnique({ where: { tenantId: tenant.id }, select: SELECT })
    return NextResponse.json(config ?? DEFAULTS)
  })
}

/** Body: `{ featureAssetFinance?: boolean, assetPayoutDualApprovalCents?: number }`. */
export async function PATCH(req: NextRequest) {
  const guard = await requireApiRole("ADMIN")
  if (guard.error) return guard.error

  return withTenantContext(req, async (tenant) => {
    const parsed = parseAssetFinanceSettings(await req.json().catch(() => null))
    if ("errors" in parsed) return NextResponse.json({ error: "Invalid asset finance settings", fields: parsed.errors }, { status: 400 })
    const input = parsed.data
    const actor = { tenantId: tenant.id, userId: guard.user.id, userEmail: guard.user.email, ipAddress: recordedCallerIp(req) ?? undefined }

    const saved = await prisma.$transaction(async (tx) => {
      // The advisory lock also serialises first writes, where no config row
      // exists yet; the row lock then covers established tenants.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`asset-finance-settings:${tenant.id}`}))`
      await tx.$executeRaw`SELECT 1 FROM "TenantConfig" WHERE "tenantId" = ${tenant.id} FOR UPDATE`
      // Read-then-write in one transaction: the audited old value is the state this write replaced.
      const prev = (await tx.tenantConfig.findUnique({ where: { tenantId: tenant.id }, select: SELECT })) ?? DEFAULTS
      const next = await tx.tenantConfig.upsert({
        where: { tenantId: tenant.id },
        update: input,
        create: { tenantId: tenant.id, ...input },
        select: SELECT,
      })
      if (prev.featureAssetFinance !== next.featureAssetFinance) {
        await logAuditStrict({
          ...actor,
          action: next.featureAssetFinance ? AuditAction.ASSET_FINANCE_MODULE_ENABLED : AuditAction.ASSET_FINANCE_MODULE_DISABLED,
          entity: "TenantConfig",
          entityId: tenant.id,
          oldValue: { featureAssetFinance: prev.featureAssetFinance },
          newValue: { featureAssetFinance: next.featureAssetFinance },
        }, tx)
      }
      if (prev.assetPayoutDualApprovalCents !== next.assetPayoutDualApprovalCents) {
        await logAuditStrict({
          ...actor,
          action: AuditAction.ASSET_PAYOUT_DUAL_APPROVAL_CHANGED,
          entity: "TenantConfig",
          entityId: tenant.id,
          oldValue: { assetPayoutDualApprovalCents: prev.assetPayoutDualApprovalCents },
          newValue: { assetPayoutDualApprovalCents: next.assetPayoutDualApprovalCents },
        }, tx)
      }
      return next
    })

    // The API gate (requireAssetFinanceEnabled) reads the row uncached; the nav,
    // the section layout and the portal pages read getTenantConfig, cached under
    // this tag. Its own try: the change is committed, a failed invalidation only
    // leaves the cached view stale for up to its revalidate window.
    try {
      revalidateTag(`tenant-config-${tenant.id}`, "max")
    } catch (error) {
      console.error("Asset finance settings saved but the tenant-config cache was not invalidated:", error)
    }
    return NextResponse.json(saved)
  })
}
