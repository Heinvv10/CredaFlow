// The vocabulary of a screening refusal: the shapes `evaluate` returns and the
// constructors that build them.
//
// Held apart from the resolution and screening logic so that a caller reading a
// failure — the backoffice, a quote API — depends on the shape without pulling
// in the rules engine, and so that adding a failure code is a change to one
// file with nothing else in it.

import type { EligibilityLifeScope, EligibilityRuleType, InsuredLifeType } from "@prisma/client"
import type { MoneyInput } from "../rand-cents"

export interface EligibilityRuleInput {
  id: string
  lifeScope: EligibilityLifeScope
  ruleType: EligibilityRuleType
  numericValue: MoneyInput | null
  textValue?: string | null
  active: boolean
}

export interface EligibilityLifeInput {
  ref: string
  lifeType: InsuredLifeType
  dateOfBirth: Date
  sumAssured: MoneyInput
}

export type FailureCode = EligibilityRuleType | "NOT_CONFIGURED" | "RULE_VALUE_MISSING" | "NO_LIVES" | "INVALID_VALUE"

export interface Failure {
  code: FailureCode
  /** The rule type at fault; null only where no rule type applies (NO_LIVES). */
  ruleType: EligibilityRuleType | null
  /** The configured rule's id, or null when the failure is that none exists. */
  ruleId: string | null
  lifeScope: EligibilityLifeScope | null
  lifeRef: string | null
  lifeType: InsuredLifeType | null
  /** The configured limit, as text; null when nothing is configured. */
  limit: string | null
  /** The offending value, as text; null where the failure is configuration, not data. */
  value: string | null
  detail: string
}

export function notConfigured(ruleType: EligibilityRuleType, life: EligibilityLifeInput): Failure {
  return {
    code: "NOT_CONFIGURED",
    ruleType,
    ruleId: null,
    lifeScope: null,
    lifeRef: life.ref,
    lifeType: life.lifeType,
    limit: null,
    value: null,
    detail: `${ruleType} is not configured for ${life.lifeType}, so this life cannot be screened`,
  }
}

/**
 * An ACTIVE rule row with no value. Reported for every rule type, not only the
 * mandatory ones: whatever the insurer meant by capturing the row, it is not a
 * limit anything can be screened against, and treating it as absent would let
 * adding a row remove a limit.
 */
export function ruleValueMissing(
  ruleType: EligibilityRuleType,
  life: EligibilityLifeInput | null,
  rule: EligibilityRuleInput,
  lifeType: InsuredLifeType | null = null,
): Failure {
  const scopeName = life?.lifeType ?? lifeType ?? rule.lifeScope
  return {
    code: "RULE_VALUE_MISSING",
    ruleType,
    ruleId: rule.id,
    lifeScope: rule.lifeScope,
    lifeRef: life?.ref ?? null,
    lifeType: life?.lifeType ?? lifeType,
    limit: null,
    value: null,
    detail: `${ruleType} is configured for ${scopeName} but carries no value, so this rule cannot screen anything`,
  }
}

/** Data the caller supplied that no rule can be applied to. */
export function invalidValue(life: EligibilityLifeInput, ruleType: EligibilityRuleType | null, detail: string): Failure {
  return {
    code: "INVALID_VALUE",
    ruleType,
    ruleId: null,
    lifeScope: null,
    lifeRef: life.ref,
    lifeType: life.lifeType,
    limit: null,
    value: null,
    detail: `${life.ref} cannot be screened: ${detail}`,
  }
}

export function bareFailure(code: FailureCode, detail: string): Failure {
  return {
    code,
    ruleType: null,
    ruleId: null,
    lifeScope: null,
    lifeRef: null,
    lifeType: null,
    limit: null,
    value: null,
    detail,
  }
}
