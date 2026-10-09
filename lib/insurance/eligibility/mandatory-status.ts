// Which of an insurer's MANDATORY acceptance terms are still missing, per life
// type — the one question both the readiness panel and the rule editor ask.
//
// It lives here, resolved through `resolveRule`, for the reason the rest of
// this module is written the way it is: readiness and screening have already
// disagreed once about the word "configured", and a product whose only
// MAX_COVER row was CHILD-scoped reported sellable while every MAIN_MEMBER life
// screened NOT_CONFIGURED. A configuration SCREEN that answered the question a
// third time, in the browser, would be a third chance to disagree — and the one
// an operator actually reads while deciding the card is finished.
//
// `product-readiness.ts` builds its reasons from this function, so the sentence
// the editor shows and the sentence the readiness panel shows are the same
// sentence, produced once.
//
// PURE, like the rest of the eligibility module: no Prisma, no I/O.

import type { InsuredLifeType } from "@prisma/client"
import { INSURED_LIFE_TYPES } from "../rating/band-match"
import { MANDATORY_RULE_TYPES, type MandatoryRuleType } from "./evaluate"
import { resolveRule } from "./rule-resolution"
import type { EligibilityRuleInput } from "./failures"

export interface MandatoryRuleStatus {
  ruleType: MandatoryRuleType
  /**
   * The life types this rule type does NOT resolve to a usable value for.
   * Empty means the term is captured for every life a quote can carry.
   */
  unresolved: InsuredLifeType[]
  /** How to say it, or null when nothing is missing. */
  reason: string | null
}

/**
 * A rule type is configured only if it resolves to a usable value for EVERY
 * life type a quote can carry — an ALL_LIVES row does that on its own, a
 * CHILD-scoped row does not. Counting any valued row of the type instead is the
 * bug this function exists to have exactly one copy of.
 */
export function mandatoryRuleStatus(rules: EligibilityRuleInput[]): MandatoryRuleStatus[] {
  return MANDATORY_RULE_TYPES.map((ruleType) => {
    const unresolved = INSURED_LIFE_TYPES.filter(
      (lifeType) => resolveRule(rules, ruleType, lifeType).status !== "OK"
    )
    return { ruleType, unresolved, reason: mandatoryReason(ruleType, unresolved) }
  })
}

function mandatoryReason(ruleType: MandatoryRuleType, unresolved: InsuredLifeType[]): string | null {
  if (unresolved.length === 0) return null
  if (unresolved.length === INSURED_LIFE_TYPES.length) {
    return `Mandatory eligibility rule ${ruleType} is not configured`
  }
  return `Mandatory eligibility rule ${ruleType} is not configured for ${unresolved.join(", ")}`
}
