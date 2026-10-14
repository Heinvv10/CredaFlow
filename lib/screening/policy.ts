import type { UserRole } from "@prisma/client"
import { prisma } from "@/lib/prisma"

/**
 * Screening thresholds and roles. Every number here is a product choice, not a
 * statutory figure: the FIC Act asks for risk-based screening, and how often a
 * lender re-screens belongs in its RMCP. Change with the lender's compliance
 * officer, not silently.
 */

/** Decision reasons must say something. Pinned to the DB CHECK ScreeningCheck_decision_complete. */
export const REVIEW_REASON_MIN_LENGTH = 15
export const REVIEW_REASON_MAX_LENGTH = 2000

/**
 * A screening run older than this is re-run before an approval, and the
 * periodic cron re-screens active clients whose latest run is older.
 */
export const SCREENING_MAX_AGE_DAYS = 30

/**
 * Wall-clock budget for one cron invocation, across tenants. The cron works
 * through the backlog oldest-first until the budget runs out and reports what
 * is left, rather than stopping at a fixed count.
 */
export const RESCREEN_TIME_BUDGET_MS = 4 * 60 * 1000

/** A provider call that has not answered by now is aborted and recorded as an ERROR. */
export const SCREENING_TIMEOUT_MS = 20_000

/**
 * A run that errored is retried, with exponential backoff: the wait after the
 * latest failure grows with the length of the failure streak, from the minimum
 * to the maximum below. The approval gate always retries at once.
 */
export const ERROR_RETRY_MIN_HOURS = 1
export const ERROR_RETRY_MAX_DAYS = 7

/**
 * A human clearance (FALSE_POSITIVE / ACCEPTED) of a possible match is reused
 * on re-screen for at most this long after it was made. REJECTED is never
 * carried: it raises a sticky ScreeningBlock instead.
 */
export const CARRY_MAX_AGE_DAYS = 365

/** Who may decide a match, per lender. Mirrors the KYC override policy's choice. */
export const SCREENING_REVIEW_MIN_ROLES = ["BRANCH_MANAGER", "ADMIN"] as const
export type ScreeningReviewMinRole = (typeof SCREENING_REVIEW_MIN_ROLES)[number]
export const SCREENING_REVIEW_MIN_ROLE_DEFAULT: ScreeningReviewMinRole = "ADMIN"

export function isScreeningReviewMinRole(value: unknown): value is ScreeningReviewMinRole {
  return value === "BRANCH_MANAGER" || value === "ADMIN"
}

export type ScreeningConfig = {
  /** null = screening not configured for this lender. */
  provider: string | null
  reviewMinRole: ScreeningReviewMinRole
  requireStaffTotp: boolean
}

type ConfigReader = Pick<typeof prisma, "tenantConfig">

export async function getScreeningConfig(tenantId: string, db: ConfigReader = prisma): Promise<ScreeningConfig> {
  const config = await db.tenantConfig.findUnique({
    where: { tenantId },
    select: { screeningProvider: true, screeningReviewMinRole: true, requireStaffTotp: true },
  })
  const role: UserRole | undefined = config?.screeningReviewMinRole
  return {
    provider: config?.screeningProvider ?? null,
    reviewMinRole: isScreeningReviewMinRole(role) ? role : SCREENING_REVIEW_MIN_ROLE_DEFAULT,
    // Fail closed, as the staff TOTP policy does: no row means 2FA required.
    requireStaffTotp: config?.requireStaffTotp ?? true,
  }
}

export function screeningCutoff(now: Date = new Date()): Date {
  return new Date(now.getTime() - SCREENING_MAX_AGE_DAYS * 24 * 60 * 60 * 1000)
}
