import type { Prisma } from "@prisma/client"
import { bureauInstalmentTotalCents, tradelineAccounts } from "./normalise"
import type { BureauAttempt, BureauReport } from "./types"

export interface ScoreDropAlert {
  previous: number
  current: number
  drop: number
}

/** A score drop this large against the same bureau's previous genuine score is flagged. */
export const SCORE_DROP_THRESHOLD = 50

export function scoreDropAlert(previous: number | null | undefined, current: number | null): ScoreDropAlert | undefined {
  if (previous == null || current == null) return undefined
  const drop = previous - current
  return drop >= SCORE_DROP_THRESHOLD ? { previous, current, drop } : undefined
}

/**
 * The `CreditBureauCheck.obligations` JSON for a report. Every reader of the
 * column depends on these keys:
 *  - `totalMonthly` (cents) → bureauMonthlyObligations → affordability's
 *    bureauObligationsCents (lib/affordability/snapshot.ts)
 *  - `simulated` → isSimulatedBureauCheck; `simulationSource` names the
 *    simulation-guard policy that governs it (absent = "experian")
 *  - `accounts` → the credit checks (lib/credit-checks/load-facts.ts)
 *  - `scoreDropAlert` → the application page
 * Undefined when there is nothing to say, as before the framework.
 */
export function reportObligations(report: BureauReport, alert?: ScoreDropAlert): Prisma.InputJsonObject | undefined {
  const totalMonthly = bureauInstalmentTotalCents(report)
  const accounts = tradelineAccounts(report.tradelines)
  if (totalMonthly == null && !alert && accounts.length === 0 && !report.simulated) return undefined
  return {
    ...(report.simulated ? { simulated: true, simulationSource: report.simulationSource ?? report.provider } : {}),
    ...(totalMonthly != null ? { totalMonthly } : {}),
    ...(alert ? { scoreDropAlert: { ...alert } } : {}),
    ...(accounts.length > 0 ? { accounts: accounts as unknown as Prisma.InputJsonArray } : {}),
  }
}

export interface CheckRowBase {
  tenantId: string
  clientId: string
  applicationId: string
  reviewGeneration: string
  subjectFingerprint: string
}

/** One CreditBureauCheck row per attempt. A failed attempt stores no bureau facts. */
export function bureauCheckRow(
  base: CheckRowBase,
  attempt: BureauAttempt,
  alert?: ScoreDropAlert,
): Prisma.CreditBureauCheckUncheckedCreateInput {
  const row = { ...base, provider: attempt.provider, attempt: attempt.attempt, status: attempt.status }
  if (attempt.status !== "OK") {
    return {
      ...row,
      score: null,
      riskGrade: null,
      adverseInfo: [],
      hasAdverse: false,
      deceased: false,
      underDebtReview: false,
      hasJudgement: false,
      hasNotice: false,
      unscoreable: false,
      declineReasons: [],
      ok: false,
      errorMessage: attempt.error,
    }
  }
  const report = attempt.report
  return {
    ...row,
    score: report.score?.value ?? null,
    riskGrade: report.score?.riskGrade ?? null,
    adverseInfo: report.defaults,
    hasAdverse: report.defaults.length > 0,
    // Columns are NOT NULL; a flag the bureau does not report is stored false.
    // Such a bureau is not an approval bureau (APPROVAL_BUREAU_PROVIDERS).
    deceased: report.deceased ?? false,
    underDebtReview: report.underDebtReview ?? false,
    hasJudgement: report.hasJudgement ?? false,
    hasNotice: report.hasNotice ?? false,
    unscoreable: report.score?.unscoreable ?? false,
    declineReasons: report.score?.declineReasons ?? [],
    ok: true,
    errorMessage: null,
    obligations: reportObligations(report, alert),
  }
}
