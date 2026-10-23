import { NextRequest, NextResponse } from "next/server"
import { revalidateTag } from "next/cache"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { recordedCallerIp } from "@/lib/rate-limit"
import { parseAssetFinanceSettings } from "@/lib/asset-finance/settings-input"
import { isCheckViolation } from "@/lib/disbursement/guard-violation"

// The tenant's asset-finance switch (TenantConfig.featureAssetFinance, DESIGN
// D9) and the payout dual-approval threshold (assetPayoutDualApprovalCents,
// D8), ADMIN only (manage_settings), each change audited. The same path as the
// IMS switch (app/api/settings/ims). Deliberately outside app/api/asset-finance:
// those routes 404 while the module is off, and this is how it is turned on.
//
// assetFinanceLegalWordingApproved is read here and never written: it is a
// Confirmation Gate set by CredaFlow once the lender's legal team approves the
// agreement wording (lib/asset-finance/settings-input.ts refuses it).
//
// The dealer portal switch and commission clawback window (SLICE5.md part A)
// are here too. CHECK TenantConfig_dealer_portal_demo_only allows the portal
// only on a demo lender until dealer 2FA ships (422). isDemoLender is read for
// the settings page and never written (the parser does not take it).
//
// The tracker position retention (SLICE5.md part B, POPIA) is here too: CHECK
// TenantConfig_telematics_retention_range keeps it to 1..365 days (422); a
// longer period needs a migration and legal sign-off.

// Schema defaults (prisma/schema/tenancy.prisma model TenantConfig), for a tenant with no config row.
const DEFAULTS = {
  featureAssetFinance: false, assetPayoutDualApprovalCents: 100_000_000, assetFinanceLegalWordingApproved: false,
  featureDealerPortal: false, dealerCommissionClawbackMonths: 0, isDemoLender: false, telematicsPositionRetentionDays: 90,
}
const SELECT = {
  featureAssetFinance: true, assetPayoutDualApprovalCents: true, assetFinanceLegalWordingApproved: true,
  featureDealerPortal: true, dealerCommissionClawbackMonths: true, isDemoLender: true, telematicsPositionRetentionDays: true,
} as const
const DEMO_ONLY = "TenantConfig_dealer_portal_demo_only"
const DEMO_ONLY_MESSAGE = "The dealer portal can be switched on only for a demo lender until dealer two-factor sign-in ships"
const RETENTION_RANGE = "TenantConfig_telematics_retention_range"
const RETENTION_MESSAGE = "Tracker positions are kept from 1 to 365 days; a longer period needs legal sign-off"

export async function GET(req: NextRequest) {
  const guard = await requireApiRole("ADMIN")
  if (guard.error) return guard.error

  return withTenantContext(req, async (tenant) => {
    const config = await prisma.tenantConfig.findUnique({ where: { tenantId: tenant.id }, select: SELECT })
    return NextResponse.json(config ?? DEFAULTS)
  })
}

/**
 * Body: `{ featureAssetFinance?: boolean, assetPayoutDualApprovalCents?: number,
 * featureDealerPortal?: boolean, dealerCommissionClawbackMonths?: number,
 * telematicsPositionRetentionDays?: number }`.
 */
export async function PATCH(req: NextRequest) {
  const guard = await requireApiRole("ADMIN")
  if (guard.error) return guard.error

  return withTenantContext(req, async (tenant) => {
    const parsed = parseAssetFinanceSettings(await req.json().catch(() => null))
    if ("errors" in parsed) return NextResponse.json({ error: "Invalid asset finance settings", fields: parsed.errors }, { status: 400 })
    const input = parsed.data
    const actor = { tenantId: tenant.id, userId: guard.user.id, userEmail: guard.user.email, ipAddress: recordedCallerIp(req) ?? undefined }

    const save = () => prisma.$transaction(async (tx) => {
      // The advisory lock also serialises first writes, where no config row
      // exists yet; the row lock then covers established tenants.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`asset-finance-settings:${tenant.id}`}))`
      await tx.$executeRaw`SELECT 1 FROM "TenantConfig" WHERE "tenantId" = ${tenant.id} FOR UPDATE`
      // Read-then-write in one transaction: the audited old value is the state this write replaced.
      const existing = await tx.tenantConfig.findUnique({ where: { tenantId: tenant.id }, select: SELECT })
      const prev = existing ?? DEFAULTS
      // Not an upsert: Postgres checks the INSERT's proposed row (isDemoLender
      // false by default) against TenantConfig_dealer_portal_demo_only before
      // ON CONFLICT turns it into an update. isDemoLender is never written here.
      const next = existing
        ? await tx.tenantConfig.update({ where: { tenantId: tenant.id }, data: input, select: SELECT })
        : await tx.tenantConfig.create({ data: { tenantId: tenant.id, ...input }, select: SELECT })
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
      if (prev.featureDealerPortal !== next.featureDealerPortal) {
        await logAuditStrict({
          ...actor,
          action: next.featureDealerPortal ? AuditAction.DEALER_PORTAL_ENABLED : AuditAction.DEALER_PORTAL_DISABLED,
          entity: "TenantConfig",
          entityId: tenant.id,
          oldValue: { featureDealerPortal: prev.featureDealerPortal },
          newValue: { featureDealerPortal: next.featureDealerPortal },
        }, tx)
      }
      if (prev.dealerCommissionClawbackMonths !== next.dealerCommissionClawbackMonths) {
        await logAuditStrict({
          ...actor,
          action: AuditAction.DEALER_CLAWBACK_MONTHS_CHANGED,
          entity: "TenantConfig",
          entityId: tenant.id,
          oldValue: { dealerCommissionClawbackMonths: prev.dealerCommissionClawbackMonths },
          newValue: { dealerCommissionClawbackMonths: next.dealerCommissionClawbackMonths },
        }, tx)
      }
      if (prev.telematicsPositionRetentionDays !== next.telematicsPositionRetentionDays) {
        await logAuditStrict({
          ...actor,
          action: AuditAction.TELEMATICS_RETENTION_CHANGED,
          entity: "TenantConfig",
          entityId: tenant.id,
          oldValue: { telematicsPositionRetentionDays: prev.telematicsPositionRetentionDays },
          newValue: { telematicsPositionRetentionDays: next.telematicsPositionRetentionDays },
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
    let saved: Awaited<ReturnType<typeof save>>
    try {
      saved = await save()
    } catch (error) {
      if (isCheckViolation(error) && String(error).includes(DEMO_ONLY)) {
        return NextResponse.json({ error: DEMO_ONLY_MESSAGE, fields: { featureDealerPortal: DEMO_ONLY_MESSAGE } }, { status: 422 })
      }
      if (isCheckViolation(error) && String(error).includes(RETENTION_RANGE)) {
        return NextResponse.json({ error: RETENTION_MESSAGE, fields: { telematicsPositionRetentionDays: RETENTION_MESSAGE } }, { status: 422 })
      }
      throw error
    }

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
