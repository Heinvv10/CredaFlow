import type { DeclineCategory } from "@prisma/client"
import type { DecisionFacts } from "./facts"
import { evaluateRules } from "./evaluate"
import { scoreApplication } from "./scorecard"
import type { RuleDef, Scorecard, Verdict } from "./types"

export const REASON_RULES_PASSED = "RULES_PASSED"
export const REASON_SCORE_BELOW_CUTOFF = "SCORE_BELOW_CUTOFF"
export const REASON_SCORE_REFER_BAND = "SCORE_REFER_BAND"
export const REASON_LIMIT_EXCEEDED = "LIMIT_EXCEEDED"
/** Codes a rule may not use; a trailing underscore reserves the prefix (HARD_GATE_*). */
export const RESERVED_REASON_CODES = [REASON_RULES_PASSED, REASON_SCORE_BELOW_CUTOFF, REASON_SCORE_REFER_BAND, REASON_LIMIT_EXCEEDED, "HARD_GATE_"] as const

/**
 * Rules and scorecard to a verdict, with a reason code for every outcome.
 * Order: a knock-out declines; else a scorecard band that declines; else any
 * refer rule, a refer band, or a limit cap below the amount asked refers; else
 * approve. A cap never trims the amount: the staff approval path approves the
 * principal applied for, so a smaller figure is a counter-offer for a person.
 * Pure: the same facts and set give the same verdict.
 */
export function decide(input: { facts: DecisionFacts; rules: readonly RuleDef[]; scorecard: Scorecard | null }): Verdict {
  const { facts, rules, scorecard } = input
  const hits = evaluateRules(rules, facts)
  const score = scorecard ? scoreApplication(scorecard, facts) : null
  const base = {
    riskGrade: score?.grade ?? null,
    score: score?.score ?? null,
    pricingTier: score?.pricingTier ?? null,
    hits,
  }
  const caps = hits.flatMap((h) => (h.outcome === "LIMIT_CAP" && h.limitCapCents !== undefined ? [h.limitCapCents] : []))
  const limitCapCents = caps.length > 0 ? Math.min(...caps) : null

  const knockOuts = hits.filter((h) => h.outcome === "KNOCK_OUT")
  if (knockOuts.length > 0) {
    const category: DeclineCategory = knockOuts[0].declineCategory ?? "POLICY"
    return { ...base, decision: "DECLINE", reasonCodes: knockOuts.map((h) => h.reasonCode), declineCategory: category, limitCapCents }
  }
  if (score?.action === "DECLINE") {
    return { ...base, decision: "DECLINE", reasonCodes: [REASON_SCORE_BELOW_CUTOFF], declineCategory: score.declineCategory ?? "POLICY", limitCapCents }
  }

  const referCodes = hits.filter((h) => h.outcome === "REFER").map((h) => h.reasonCode)
  if (score?.action === "REFER") referCodes.push(REASON_SCORE_REFER_BAND)
  if (limitCapCents !== null && facts.requestedAmountCents > limitCapCents) {
    referCodes.push(...hits.filter((h) => h.outcome === "LIMIT_CAP").map((h) => h.reasonCode), REASON_LIMIT_EXCEEDED)
  }
  if (referCodes.length > 0) {
    return { ...base, decision: "REFER", reasonCodes: [...new Set(referCodes)], declineCategory: null, limitCapCents }
  }
  return { ...base, decision: "APPROVE", reasonCodes: [REASON_RULES_PASSED], declineCategory: null, limitCapCents }
}
