import type { Prisma } from "@prisma/client"
import type { prisma } from "@/lib/prisma"
import { AuditAction } from "@/lib/audit"
import type { GoLiveInputs } from "@/lib/loan/charges-inputs"

// Switching a tenant's default charges on (once) and off (for good)
// (scripts/default-charges-backfill.ts). ALL money is CENTS. The kill switch
// is one-way: after --disable nothing is derived for the tenant again, charges
// clients already paid stay paid, unpaid ones are not collected, and --apply
// refuses to re-enable.
//
// The switch is per tenant, not per regime: it also gates the NON_NCA arrears
// charges (lib/asset-finance/non-nca-charges.ts). While it is off, or after a
// stop, a NON_NCA loan accrues no default interest or collection fee either.

type SwitchTx = Pick<typeof prisma, "tenantConfig" | "complianceRecord" | "auditLog">
export type SwitchDb = SwitchTx & Pick<typeof prisma, "$transaction">
export interface SwitchActor { userId: string; userEmail: string }

/** Refused: charges were stopped for this tenant, and re-enabling is not supported. */
export class ChargesStopped extends Error {
  constructor(stoppedAt: Date) {
    super(`charges were stopped on ${stoppedAt.toISOString()}; re-enabling is not supported`)
    this.name = "ChargesStopped"
  }
}

/**
 * What --apply switches the tenant to — the dry run previews exactly this:
 * go-live kept when already recorded (`asOf` the first time), and the admin
 * charge stamped on unfrozen notices. Refuses once charges were stopped.
 */
export async function goLiveInputs(db: Pick<SwitchTx, "tenantConfig">, tenantId: string, asOf: Date): Promise<GoLiveInputs> {
  const config = await db.tenantConfig.findUnique({
    where: { tenantId },
    select: {
      defaultChargesStartedAt: true, defaultChargesStoppedAt: true,
      defaultAdminChargeCents: true, defaultAdminPostageCents: true,
    },
  })
  if (!config) throw new Error(`Tenant ${tenantId} has no TenantConfig`)
  if (config.defaultChargesStoppedAt) throw new ChargesStopped(config.defaultChargesStoppedAt)
  return {
    startedAt: config.defaultChargesStartedAt ?? asOf,
    letterCents: config.defaultAdminChargeCents + config.defaultAdminPostageCents,
  }
}

/** Issued Section 129 notices with no frozen admin charge (issued before amounts were frozen). */
export async function unfrozenNotices(db: Pick<SwitchTx, "complianceRecord">, tenantId: string) {
  const notices = await db.complianceRecord.findMany({
    where: {
      tenantId, type: "SECTION_129_NOTICE", status: "COMPLETED", completedAt: { not: null },
      data: { path: ["lifecycle"], equals: "ISSUED" },
    },
    orderBy: { id: "asc" },
    select: { id: true, referenceId: true, data: true },
  })
  return notices.filter((n) => typeof (n.data as { adminChargeCents?: unknown }).adminChargeCents !== "number")
}

/**
 * Freezes today's admin charge (charge + postage) onto every issued notice
 * lacking one, audited per notice, so the replay never reads the live
 * setting for a letter.
 */
export async function stampUnfrozenNotices(
  tx: SwitchTx, tenantId: string, inputs: GoLiveInputs, actor: SwitchActor,
): Promise<number> {
  const notices = await unfrozenNotices(tx, tenantId)
  const adminChargeCents = inputs.letterCents
  for (const notice of notices) {
    await tx.complianceRecord.update({
      where: { id: notice.id },
      data: { data: { ...(notice.data as Prisma.JsonObject), adminChargeCents } },
    })
    await tx.auditLog.create({
      data: {
        tenantId, userId: actor.userId, userEmail: actor.userEmail,
        action: AuditAction.SECTION_129_CHARGE_STAMPED, entity: "ComplianceRecord", entityId: notice.id,
        oldValue: { adminChargeCents: null },
        newValue: { adminChargeCents, loanId: notice.referenceId, source: "backfill" },
      },
    })
  }
  return notices.length
}

/** Switches charges on and records go-live, audited, unless already live. */
export async function switchChargesOn(tx: SwitchTx, tenantId: string, inputs: GoLiveInputs, actor: SwitchActor): Promise<void> {
  const config = await tx.tenantConfig.findUnique({
    where: { tenantId },
    select: { defaultChargesEnabled: true, defaultChargesStartedAt: true, defaultChargesStoppedAt: true },
  })
  if (!config) throw new Error(`Tenant ${tenantId} has no TenantConfig`)
  if (config.defaultChargesStoppedAt) throw new ChargesStopped(config.defaultChargesStoppedAt)
  if (config.defaultChargesEnabled && config.defaultChargesStartedAt) return
  // Conditional on what was read, so two concurrent runs cannot both switch it.
  const updated = await tx.tenantConfig.updateMany({
    where: {
      tenantId, defaultChargesStoppedAt: null,
      defaultChargesEnabled: config.defaultChargesEnabled, defaultChargesStartedAt: config.defaultChargesStartedAt,
    },
    data: { defaultChargesEnabled: true, defaultChargesStartedAt: inputs.startedAt },
  })
  if (updated.count !== 1) throw new Error(`TenantConfig for ${tenantId} changed concurrently; re-run`)
  await tx.auditLog.create({
    data: {
      tenantId, userId: actor.userId, userEmail: actor.userEmail,
      action: AuditAction.DEFAULT_CHARGES_STARTED, entity: "TenantConfig", entityId: tenantId,
      oldValue: {
        defaultChargesEnabled: config.defaultChargesEnabled,
        defaultChargesStartedAt: config.defaultChargesStartedAt?.toISOString() ?? null,
      },
      newValue: { defaultChargesEnabled: true, defaultChargesStartedAt: inputs.startedAt.toISOString(), source: "backfill" },
    },
  })
}

/**
 * The kill switch, one-way and audited: switches charges off and records
 * when. Stored charge rows and receipt splits are left exactly as they are.
 */
export async function disableCharges(db: SwitchDb, tenantId: string, asOf: Date, actor: SwitchActor): Promise<{ changed: boolean }> {
  return await db.$transaction(async (tx) => {
    const config = await tx.tenantConfig.findUnique({
      where: { tenantId },
      select: { defaultChargesEnabled: true, defaultChargesStartedAt: true, defaultChargesStoppedAt: true },
    })
    if (!config) throw new Error(`Tenant ${tenantId} has no TenantConfig`)
    if (config.defaultChargesStoppedAt) return { changed: false }
    // Stopping is permanent: never let it brick a feature that was never on.
    if (!config.defaultChargesStartedAt) {
      throw new Error("charges were never switched on for this tenant; there is nothing to stop")
    }
    const updated = await tx.tenantConfig.updateMany({
      where: { tenantId, defaultChargesStoppedAt: null },
      data: { defaultChargesEnabled: false, defaultChargesStoppedAt: asOf },
    })
    if (updated.count === 0) return { changed: false }
    await tx.auditLog.create({
      data: {
        tenantId, userId: actor.userId, userEmail: actor.userEmail,
        action: AuditAction.DEFAULT_CHARGES_DISABLED, entity: "TenantConfig", entityId: tenantId,
        oldValue: {
          defaultChargesEnabled: config.defaultChargesEnabled,
          defaultChargesStartedAt: config.defaultChargesStartedAt.toISOString(),
          wasLive: config.defaultChargesEnabled,
        },
        newValue: { defaultChargesEnabled: false, defaultChargesStoppedAt: asOf.toISOString() },
      },
    })
    return { changed: true }
  })
}
