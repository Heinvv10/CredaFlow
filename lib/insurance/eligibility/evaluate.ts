// Screening a proposed quote against the INSURER's stated acceptance terms.
//
// This is not underwriting. No decision is made here that the insurer has not
// already specified as data in `InsuranceEligibilityRule`. Its only purpose is
// to stop the lender selling a policy the insurer would reject.
//
// PURE: no Prisma, no I/O, no `new Date()`. Ages come from the caller's
// effective date. Money is compared in exact cents.
//
// THE CENTRAL SAFETY RULE: absent or unusable configuration is not a pass.
// Concretely, and no more broadly than the code does:
//
//   - A MANDATORY rule type (`MANDATORY_RULE_TYPES`) that resolves to nothing
//     for a life is a NOT_CONFIGURED failure for that life. The other rule
//     types have NO such backstop — a product with no MIN_COVER row is simply
//     not screened on minimum cover, which is the insurer saying there is no
//     minimum, not a gap.
//   - An ACTIVE rule row carrying no value is a RULE_VALUE_MISSING failure for
//     ANY rule type, mandatory or not. This is the narrower fix for a real
//     defect: scope resolution preferred a life-type-scoped row over ALL_LIVES
//     without checking it had a value, so ADDING a valueless row DISABLED the
//     ALL_LIVES limit the product already had. Adding configuration must never
//     make the screen weaker.
//   - `evaluate` is TOTAL: invalid data — a date of birth after the effective
//     date, an unparseable sum assured, a configured limit that is not a rand
//     amount — is an INVALID_VALUE failure, never a throw. `EvaluateResult`
//     promises a result, so the function must return one.
//   - The aggregate screened against MAX_TOTAL_COVER is DERIVED from the lives.
//     It was once a caller-supplied parameter, which meant a caller could
//     declare a total smaller than the cover it was asking for and clear the
//     cap. There is no such parameter now.
//   - MAX_TOTAL_COVER HONOURS ITS SCOPE. The ALL_LIVES row caps the whole
//     quote; a row scoped to a life type caps the aggregate cover of the lives
//     OF THAT TYPE. The product-level check used to resolve it with
//     `lifeType: null` regardless, so a scoped row stored, displayed as
//     configured, and screened nothing — configuration that silently does not
//     apply is the same silent pass as configuration that is absent.
//
// This repo has a documented defect class where a guard given no input
// silently passed; this module is written to fail the other way.

import type { EligibilityRuleType, InsuredLifeType } from "@prisma/client"
import { toCents } from "../rand-cents"
import {
  bareFailure,
  checkCount,
  checkTotalCover,
  checkMoney,
  invalidValue,
  notConfigured,
  resolveRule,
  ruleLimitCents,
  ruleValueMissing,
  type EligibilityLifeInput,
  type EligibilityRuleInput,
  type Failure,
} from "./rule-resolution"

// Re-exported so `evaluate.ts` stays the module's front door: callers import
// what they screen with from the thing that screens.
export {
  resolveRule,
  type EligibilityLifeInput,
  type EligibilityRuleInput,
  type Failure,
  type FailureCode,
  type RuleResolution,
} from "./rule-resolution"
import { ageAtDate } from "../rating/rate-quote"

/**
 * The rule types an insurer arrangement must specify before anything may be
 * quoted. Each one that is missing, deactivated, or configured without a value
 * blocks the product. `product-readiness.ts` screens the same set, THROUGH THE
 * SAME `resolveRule` — a readiness check that resolved scope differently is how
 * `canSellProduct` once reported a product sellable while every life screened
 * NOT_CONFIGURED against it.
 */
export const MANDATORY_RULE_TYPES = [
  "MIN_ENTRY_AGE",
  "MAX_ENTRY_AGE",
  "MAX_COVER",
  "WAITING_PERIOD_DAYS",
] as const satisfies readonly EligibilityRuleType[]

export type MandatoryRuleType = (typeof MANDATORY_RULE_TYPES)[number]

/**
 * Rule types that describe the quote as a whole rather than one life. They are
 * resolved once, against the ALL_LIVES scope (MAX_LIVES_OF_TYPE additionally
 * per life type, since that is what it counts).
 */
export const PRODUCT_LEVEL_RULE_TYPES = [
  "MAX_TOTAL_COVER",
  "MAX_LIVES_OF_TYPE",
] as const satisfies readonly EligibilityRuleType[]

/** Rule types resolved once per life. */
export const PER_LIFE_RULE_TYPES = [
  "MIN_ENTRY_AGE",
  "MAX_ENTRY_AGE",
  "MIN_COVER",
  "MAX_COVER",
  "WAITING_PERIOD_DAYS",
  "COOLING_OFF_DAYS",
] as const satisfies readonly EligibilityRuleType[]

/**
 * Every rule type this module knows about. Hand-written so the module keeps its
 * promise of importing nothing from the generated client at runtime; a test
 * compares it against the real Prisma enum so it cannot drift silently.
 */
export const ALL_RULE_TYPES = [
  ...PER_LIFE_RULE_TYPES,
  ...PRODUCT_LEVEL_RULE_TYPES,
] as const satisfies readonly EligibilityRuleType[]

export interface EvaluateParams {
  rules: EligibilityRuleInput[]
  lives: EligibilityLifeInput[]
  effectiveDate: Date
}

export interface EvaluateResult {
  pass: boolean
  failures: Failure[]
}

export function evaluate({ rules, lives, effectiveDate }: EvaluateParams): EvaluateResult {
  const failures: Failure[] = []

  if (lives.length === 0) {
    failures.push(bareFailure("NO_LIVES", "A quote must cover at least one life"))
    return { pass: false, failures }
  }

  // The cover screened against MAX_TOTAL_COVER, derived from the lives
  // themselves. Only lives whose cover parsed contribute; one that did not has
  // already produced an INVALID_VALUE failure, so `pass` is false regardless.
  //
  // Kept per life type as well as in total, because a MAX_TOTAL_COVER row
  // scoped to a life type caps the aggregate cover OF THAT TYPE.
  const coverCentsByLifeType = new Map<InsuredLifeType, number[]>()

  for (const life of lives) {
    let age: number
    try {
      age = ageAtDate(life.dateOfBirth, effectiveDate)
    } catch (error) {
      failures.push(invalidValue(life, null, (error as Error).message))
      continue
    }

    let lifeSumAssuredCents: number
    try {
      lifeSumAssuredCents = toCents(life.sumAssured)
    } catch (error) {
      failures.push(invalidValue(life, null, (error as Error).message))
      continue
    }
    coverCentsByLifeType.set(life.lifeType, [
      ...(coverCentsByLifeType.get(life.lifeType) ?? []),
      lifeSumAssuredCents,
    ])

    // Configuration first, per life, so the operator sees exactly which life is
    // unscreened and why: a mandatory type that resolves to nothing, or ANY
    // type whose resolved row carries no value.
    for (const ruleType of PER_LIFE_RULE_TYPES) {
      const resolved = resolveRule(rules, ruleType, life.lifeType)
      if (resolved.status === "NONE") {
        if ((MANDATORY_RULE_TYPES as readonly EligibilityRuleType[]).includes(ruleType)) {
          failures.push(notConfigured(ruleType, life))
        }
        continue
      }
      if (resolved.status === "VALUE_MISSING") {
        failures.push(ruleValueMissing(ruleType, life, resolved.rule))
      }
    }

    checkCount(rules, "MIN_ENTRY_AGE", life, age, "below", failures)
    checkCount(rules, "MAX_ENTRY_AGE", life, age, "above", failures)
    checkMoney(rules, "MIN_COVER", life, lifeSumAssuredCents, "below", failures)
    checkMoney(rules, "MAX_COVER", life, lifeSumAssuredCents, "above", failures)
  }

  // Product-level: the aggregate cover of the lives, and how many lives of each
  // type the insurer will accept.
  //
  // The ALL_LIVES row caps the whole quote. A row SCOPED to a life type caps
  // the aggregate for that type only — it used to be resolved with
  // `lifeType: null`, so the API accepted and stored it, the backoffice showed
  // it as configured, and it screened nothing at all.
  //
  // A scoped row is honoured only where it really is scoped: `resolveRule`
  // falls back to ALL_LIVES, and re-applying that fallback per life type would
  // report the same breach up to four extra times. A subtotal can never exceed
  // the total anyway, so the fallback would add no screening either.
  checkTotalCover(rules, null, [...coverCentsByLifeType.values()].flat(), failures)
  for (const [lifeType, coverCents] of coverCentsByLifeType) {
    const scoped = resolveRule(rules, "MAX_TOTAL_COVER", lifeType)
    if (scoped.status === "NONE" || scoped.rule.lifeScope !== lifeType) continue
    checkTotalCover(rules, lifeType, coverCents, failures)
  }

  const counts = countByLifeType(lives)
  for (const [lifeType, count] of counts) {
    const resolved = resolveRule(rules, "MAX_LIVES_OF_TYPE", lifeType)
    if (resolved.status === "VALUE_MISSING") {
      failures.push(ruleValueMissing("MAX_LIVES_OF_TYPE", null, resolved.rule, lifeType))
      continue
    }
    if (resolved.status === "NONE") continue

    const limitCents = ruleLimitCents(resolved, "MAX_LIVES_OF_TYPE", null, failures, lifeType)
    if (limitCents === null) continue
    const limit = limitCents / 100
    if (count > limit) {
      failures.push({
        code: "MAX_LIVES_OF_TYPE",
        ruleType: "MAX_LIVES_OF_TYPE",
        ruleId: resolved.rule.id,
        lifeScope: resolved.rule.lifeScope,
        lifeRef: null,
        lifeType,
        limit: String(limit),
        value: String(count),
        detail: `${count} lives of type ${lifeType} exceeds the maximum of ${limit}`,
      })
    }
  }

  return { pass: failures.length === 0, failures }
}

function countByLifeType(lives: EligibilityLifeInput[]): Map<InsuredLifeType, number> {
  const counts = new Map<InsuredLifeType, number>()
  for (const life of lives) {
    counts.set(life.lifeType, (counts.get(life.lifeType) ?? 0) + 1)
  }
  return counts
}
