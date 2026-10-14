// NCA s.81 (reckless lending prohibition) requires a current credit
// assessment before entering into a credit agreement. NCR enforcement
// guidance for short-term unsecured lending treats 30-60 days as "current";
// 90 days is on the edge. 60 days is the CEILING no tenant may exceed (also a
// CHECK on TenantConfig.bureauMaxAgeDays); each tenant chooses its own window
// at or below it. The default is the ceiling, so a tenant that sets nothing
// keeps the window it had before the setting existed.
//
// Single source so /decide, /agreement, /sign and /disburse stay in lockstep —
// drift between them would let a stale check pass approval and then a fresh
// window refuse disburse, or vice versa.
export const BUREAU_STALENESS_DAYS = 60
export const DEFAULT_BUREAU_MAX_AGE_DAYS = BUREAU_STALENESS_DAYS

/** The tenant's freshness window in days: its setting, clamped to 1..ceiling;
 *  the default when the tenant has no config row (or no value). */
export function bureauMaxAgeDays(config: { bureauMaxAgeDays?: number | null } | null | undefined): number {
  const days = config?.bureauMaxAgeDays
  if (typeof days !== "number" || !Number.isInteger(days)) return DEFAULT_BUREAU_MAX_AGE_DAYS
  return Math.min(Math.max(days, 1), BUREAU_STALENESS_DAYS)
}

/** Oldest `createdAt` a bureau check may have and still count as current. */
export function bureauStalenessCutoff(maxAgeDays: number, now: Date = new Date()): Date {
  const days = Math.min(Math.max(maxAgeDays, 1), BUREAU_STALENESS_DAYS)
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000)
}

/**
 * Bureaus whose checks can satisfy the approval bureau gate. The gate's floor
 * (TenantConfig.bureauMinScore) is calibrated on the Experian Sigma band
 * (480–710) and its hard stops need the deceased / debt-review / judgement /
 * notice flags. A bureau joins this list only when its score is on that band
 * and it reports those flags — or when the gate learns per-bureau floors.
 * "simulated" reports on the Sigma band by construction; simulatedBureauBlock
 * refuses it wherever simulation is forbidden, like the Experian dry-run.
 */
export const APPROVAL_BUREAU_PROVIDERS: readonly string[] = ["experian", "simulated"]

export function isApprovalBureau(providerId: string): boolean {
  return APPROVAL_BUREAU_PROVIDERS.includes(providerId)
}

/** What makes any bureau check usable for approval: successful, current under
 *  the tenant's window, from an approval bureau. Batched reads (the board's
 *  readiness) bind the application and generation themselves. */
export function approvalBureauCheckUsableWhere(args: { maxAgeDays: number; now?: Date }) {
  return {
    ok: true as const,
    createdAt: { gte: bureauStalenessCutoff(args.maxAgeDays, args.now) },
    provider: { in: [...APPROVAL_BUREAU_PROVIDERS] },
  }
}

/** The approval-path bureau read: this review generation, plus approvalBureauCheckUsableWhere. */
export function approvalBureauCheckWhere(args: {
  tenantId: string
  applicationId: string
  clientId: string
  reviewGeneration: string
  maxAgeDays: number
  now?: Date
}) {
  return {
    tenantId: args.tenantId,
    applicationId: args.applicationId,
    clientId: args.clientId,
    reviewGeneration: args.reviewGeneration,
    ...approvalBureauCheckUsableWhere(args),
  }
}
