import { SIGMA_SCORE_MIN } from "@/lib/integrations/experian"
import { isSimulatedBureauCheck, simulatedBureauBlock } from "@/lib/decision/bureau-simulated"
import { bureauObligationsKnown } from "@/lib/affordability/snapshot"

export { isSimulatedBureauCheck }

export interface BureauGateCheck {
  score: number | null
  unscoreable: boolean
  hasAdverse: boolean
  deceased: boolean
  underDebtReview: boolean
  hasJudgement: boolean
  hasNotice: boolean
  /** The stored `CreditBureauCheck.obligations` JSON, which carries the `simulated` marker. */
  obligations?: unknown
  /** The check's bureau; a "simulated" one is simulated whatever its marker says. */
  provider?: string
}

/** Pure bureau approval gate. Hard-stops first, then the score gate. An
 *  uncalibrated floor (below the Sigma band) is NOT a silent pass — it blocks
 *  as requires-calibration so ops must set an in-band bureauMinScore. */
export function evaluateBureauGate(
  check: BureauGateCheck,
  cfg: { bureauMinScore: number; bureauBlockAdverse: boolean },
): { blocked: boolean; reason?: string; requiresCalibration?: boolean } {
  const simulated = simulatedBureauBlock(check)
  if (simulated.blocked) return simulated
  if (check.deceased) return { blocked: true, reason: "Consumer is marked deceased at the bureau." }
  if (check.underDebtReview) return { blocked: true, reason: "Consumer is under debt review (NCA s.88)." }
  if (check.hasJudgement) return { blocked: true, reason: "Consumer has one or more court judgements." }
  if (check.hasNotice) return { blocked: true, reason: "Consumer has one or more bureau notices (e.g. sequestration)." }
  if (cfg.bureauBlockAdverse && check.hasAdverse) return { blocked: true, reason: "Consumer has adverse account information." }
  // Fail closed: a report with no accounts and no total would read as zero debt.
  if (!bureauObligationsKnown(check.obligations)) {
    return { blocked: true, reason: "The bureau report states no accounts or instalments, so the consumer's debt is unknown — manual review required." }
  }

  if (cfg.bureauMinScore < SIGMA_SCORE_MIN) {
    return { blocked: true, requiresCalibration: true, reason: "Bureau score gate is not calibrated to the Sigma band — manual review required." }
  }
  if (check.unscoreable || check.score == null) {
    return { blocked: true, reason: "Consumer could not be scored by the bureau." }
  }
  if (check.score < cfg.bureauMinScore) {
    return { blocked: true, reason: `Bureau score ${check.score} below the minimum ${cfg.bureauMinScore}.` }
  }
  return { blocked: false }
}

/** Bureau markers that an audited override CANNOT bypass. Deceased is
 *  non-overridable: you cannot lend to a consumer
 *  the bureau reports as deceased, regardless of a staff override reason. */
export function nonOverridableBlock(check: { deceased: boolean }): { blocked: boolean; reason?: string } {
  if (check.deceased) {
    return { blocked: true, reason: "The bureau reports this consumer as deceased." }
  }
  return { blocked: false }
}
