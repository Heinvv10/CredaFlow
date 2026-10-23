import { SIGMA_SCORE_MIN } from "@/lib/integrations/experian-spec"
import { simulatedBureauBlock } from "@/lib/decision/bureau-simulated"
import { bureauObligationsKnown } from "@/lib/affordability/snapshot"

/** The check fields the bureau gate reads (lib/decision/bureau-gate.ts). */
export interface BureauFacts {
  score: number | null
  unscoreable: boolean
  hasAdverse: boolean
  deceased: boolean
  underDebtReview: boolean
  hasJudgement: boolean
  hasNotice: boolean
  /** Read only to decide whether the obligations are known; never logged. */
  obligations?: unknown
  provider?: string
}

export type BureauBlockCode =
  | "SIMULATED"
  | "DECEASED"
  | "DEBT_REVIEW"
  | "JUDGEMENT"
  | "NOTICE"
  | "ADVERSE"
  | "OBLIGATIONS_UNKNOWN"
  | "UNCALIBRATED"
  | "UNSCOREABLE"
  | "BELOW_MIN_SCORE"

/**
 * Why the bureau gate blocks, as a code rather than its sentence (the
 * sentence quotes the score). Same checks in the same order as
 * evaluateBureauGate; bureau-code.test.ts holds the two together.
 */
export function bureauBlockCode(
  check: BureauFacts,
  cfg: { bureauMinScore: number; bureauBlockAdverse: boolean },
): BureauBlockCode | null {
  if (simulatedBureauBlock(check).blocked) return "SIMULATED"
  if (check.deceased) return "DECEASED"
  if (check.underDebtReview) return "DEBT_REVIEW"
  if (check.hasJudgement) return "JUDGEMENT"
  if (check.hasNotice) return "NOTICE"
  if (cfg.bureauBlockAdverse && check.hasAdverse) return "ADVERSE"
  if (!bureauObligationsKnown(check.obligations)) return "OBLIGATIONS_UNKNOWN"
  if (cfg.bureauMinScore < SIGMA_SCORE_MIN) return "UNCALIBRATED"
  if (check.unscoreable || check.score == null) return "UNSCOREABLE"
  if (check.score < cfg.bureauMinScore) return "BELOW_MIN_SCORE"
  return null
}
