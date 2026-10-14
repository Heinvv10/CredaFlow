import type { prisma } from "@/lib/prisma"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { isSimulationPermitted } from "@/lib/integrations/simulation-guard"
import { getScreeningProvider, isKnownScreeningProvider } from "./registry"
import { getScreeningConfig, isScreeningReviewMinRole, type ScreeningReviewMinRole } from "./policy"

type Tx = Pick<typeof prisma, "$executeRaw" | "tenantConfig" | "auditLog">

export type ScreeningConfigInput = { provider: unknown; reviewMinRole: unknown; requireSecondReviewer: unknown }

export type ParsedScreeningConfig = { provider: string | null; reviewMinRole: ScreeningReviewMinRole; requireSecondReviewer: boolean }

/**
 * Validates a screening-settings write. Refuses an unknown provider, a review
 * role other than BRANCH_MANAGER or ADMIN, a non-boolean maker-checker
 * setting, and the simulated provider on a deployment that forbids simulated
 * screening.
 */
export function parseScreeningConfig(input: ScreeningConfigInput): { ok: true; value: ParsedScreeningConfig } | { ok: false; error: string } {
  const provider = input.provider === null || input.provider === "" ? null : input.provider
  if (provider !== null && !isKnownScreeningProvider(provider)) {
    return { ok: false, error: "Unknown screening provider." }
  }
  if (!isScreeningReviewMinRole(input.reviewMinRole)) {
    return { ok: false, error: "Minimum review role must be BRANCH_MANAGER or ADMIN." }
  }
  if (typeof input.requireSecondReviewer !== "boolean") {
    return { ok: false, error: "requireSecondReviewer must be true or false." }
  }
  if (provider !== null && getScreeningProvider(provider).simulated && !isSimulationPermitted("screening")) {
    return { ok: false, error: "The simulated provider is not permitted on this deployment." }
  }
  return { ok: true, value: { provider, reviewMinRole: input.reviewMinRole, requireSecondReviewer: input.requireSecondReviewer } }
}

/** Writes TenantConfig's screening settings and their audit row in the caller's transaction. */
export async function applyScreeningConfig(
  tx: Tx,
  args: { tenantId: string; actor: { id: string; email: string }; value: ParsedScreeningConfig; ipAddress?: string },
): Promise<{ changed: boolean }> {
  const { tenantId, actor, value, ipAddress } = args
  await tx.$executeRaw`SELECT 1 FROM "TenantConfig" WHERE "tenantId" = ${tenantId} FOR UPDATE`
  const before = await getScreeningConfig(tenantId, tx)
  if (before.provider === value.provider && before.reviewMinRole === value.reviewMinRole
      && before.requireSecondReviewer === value.requireSecondReviewer) return { changed: false }
  const data = { screeningProvider: value.provider, screeningReviewMinRole: value.reviewMinRole, requireSecondReviewer: value.requireSecondReviewer }
  await tx.tenantConfig.upsert({ where: { tenantId }, update: data, create: { tenantId, ...data } })
  await logAuditStrict({
    tenantId,
    userId: actor.id,
    userEmail: actor.email,
    action: AuditAction.SCREENING_CONFIG_UPDATED,
    entity: "TenantConfig",
    entityId: tenantId,
    oldValue: { provider: before.provider, reviewMinRole: before.reviewMinRole, requireSecondReviewer: before.requireSecondReviewer },
    newValue: { provider: value.provider, reviewMinRole: value.reviewMinRole, requireSecondReviewer: value.requireSecondReviewer },
    ipAddress,
  }, tx)
  return { changed: true }
}
