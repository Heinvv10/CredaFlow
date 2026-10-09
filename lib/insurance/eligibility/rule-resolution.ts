// What an insurer's captured rules SAY for a given life type, and the shapes a
// screening failure takes.
//
// Split from `evaluate.ts` at its natural seam. That file answers "does this
// quote pass"; this one answers "what did the insurer configure for this life
// type, and how is a refusal described". `product-readiness.ts` needs only the
// second question — and asking it through the SAME `resolveRule` is what stops
// readiness and screening disagreeing about the word "configured", which is a
// defect this module has already had once.
//
// PURE, like its caller: no Prisma, no I/O, no `new Date()`.

import type { EligibilityRuleType, InsuredLifeType } from "@prisma/client"
import { addCents, formatCents, toCents } from "../rand-cents"
import type { MoneyInput } from "../rand-cents"
import {
  ruleValueMissing,
  type EligibilityLifeInput,
  type EligibilityRuleInput,
  type Failure,
} from "./failures"

export * from "./failures"

/**
 * What a rule type resolves to for one life type. Three outcomes, not two: a
 * row that exists but carries no value is NOT the same as no row, and
 * collapsing the two is the defect this type exists to make unrepresentable.
 */
export type RuleResolution =
  | { status: "NONE" }
  | { status: "VALUE_MISSING"; rule: EligibilityRuleInput }
  | { status: "OK"; rule: EligibilityRuleInput; numericValue: MoneyInput }

/**
 * A rule scoped to the life's own type overrides the ALL_LIVES rule for that
 * type. Passing a null life type asks only for the ALL_LIVES rule, which is
 * what the product-level checks want.
 *
 * Inactive rows are filtered here rather than by the caller, so no caller can
 * forget. A scoped row still wins even when it carries no value — that is what
 * the insurer configured, and reporting it as VALUE_MISSING is the only answer
 * that does not silently fall back to a limit nobody chose.
 *
 * `product-readiness.ts` calls this too. The two MUST agree on what
 * "configured" means; when they did not, a product whose only MAX_COVER row was
 * CHILD-scoped reported `sellable: true` while every MAIN_MEMBER life screened
 * NOT_CONFIGURED.
 */
export function resolveRule(
  rules: EligibilityRuleInput[],
  ruleType: EligibilityRuleType,
  lifeType: InsuredLifeType | null,
): RuleResolution {
  const ofType = rules.filter((rule) => rule.active && rule.ruleType === ruleType)
  const scoped = lifeType ? ofType.find((rule) => rule.lifeScope === lifeType) : undefined
  const rule = scoped ?? ofType.find((rule) => rule.lifeScope === "ALL_LIVES")

  if (!rule) return { status: "NONE" }
  if (rule.numericValue === null || rule.numericValue === undefined) return { status: "VALUE_MISSING", rule }
  return { status: "OK", rule, numericValue: rule.numericValue }
}

/**
 * A configured limit in cents, or null having recorded an INVALID_VALUE. A rand
 * amount the insurer's row cannot express is a configuration fault, not a
 * reason to throw out of a function typed to return failures.
 */
export function ruleLimitCents(
  resolved: Extract<RuleResolution, { status: "OK" }>,
  ruleType: EligibilityRuleType,
  life: EligibilityLifeInput | null,
  failures: Failure[],
  lifeType: InsuredLifeType | null = null,
): number | null {
  const { rule } = resolved
  try {
    return toCents(resolved.numericValue)
  } catch (error) {
    failures.push({
      code: "INVALID_VALUE",
      ruleType,
      ruleId: rule.id,
      lifeScope: rule.lifeScope,
      lifeRef: life?.ref ?? null,
      lifeType: life?.lifeType ?? lifeType,
      limit: null,
      value: null,
      detail: `${ruleType} is configured with an unusable value: ${(error as Error).message}`,
    })
    return null
  }
}

export function checkCount(
  rules: EligibilityRuleInput[],
  ruleType: EligibilityRuleType,
  life: EligibilityLifeInput,
  value: number,
  direction: "below" | "above",
  failures: Failure[],
): void {
  const resolved = resolveRule(rules, ruleType, life.lifeType)
  // NONE and VALUE_MISSING are already reported by the per-life configuration
  // pass above; screening cannot proceed without a value either way.
  if (resolved.status !== "OK") return

  const limitCents = ruleLimitCents(resolved, ruleType, life, failures)
  if (limitCents === null) return
  const limit = limitCents / 100
  const breached = direction === "below" ? value < limit : value > limit
  if (!breached) return

  failures.push({
    code: ruleType,
    ruleType,
    ruleId: resolved.rule.id,
    lifeScope: resolved.rule.lifeScope,
    lifeRef: life.ref,
    lifeType: life.lifeType,
    limit: String(limit),
    value: String(value),
    detail: `${life.ref} is ${value}, ${direction} the configured ${ruleType} of ${limit}`,
  })
}

export function checkMoney(
  rules: EligibilityRuleInput[],
  ruleType: EligibilityRuleType,
  life: EligibilityLifeInput,
  valueCents: number,
  direction: "below" | "above",
  failures: Failure[],
): void {
  const resolved = resolveRule(rules, ruleType, life.lifeType)
  if (resolved.status !== "OK") return

  const limitCents = ruleLimitCents(resolved, ruleType, life, failures)
  if (limitCents === null) return
  const breached = direction === "below" ? valueCents < limitCents : valueCents > limitCents
  if (!breached) return

  failures.push({
    code: ruleType,
    ruleType,
    ruleId: resolved.rule.id,
    lifeScope: resolved.rule.lifeScope,
    lifeRef: life.ref,
    lifeType: life.lifeType,
    limit: formatCents(limitCents),
    value: formatCents(valueCents),
    detail: `${life.ref} is covered for ${formatCents(valueCents)}, ${direction} the configured ${ruleType} of ${formatCents(limitCents)}`,
  })
}

/**
 * Screen an aggregate of cover against MAX_TOTAL_COVER, for the whole quote
 * (`lifeType: null`, the ALL_LIVES row) or for the lives of one type (a row
 * scoped to it).
 */
export function checkTotalCover(
  rules: EligibilityRuleInput[],
  lifeType: InsuredLifeType | null,
  coverCents: number[],
  failures: Failure[],
): void {
  const resolved = resolveRule(rules, "MAX_TOTAL_COVER", lifeType)
  if (resolved.status === "NONE") return
  if (resolved.status === "VALUE_MISSING") {
    failures.push(ruleValueMissing("MAX_TOTAL_COVER", null, resolved.rule, lifeType))
    return
  }

  // `addCents`, not a bare `+=`. It refuses a sum that leaves the exact-cent
  // range instead of returning a drifting float — and the bare accumulation
  // this replaced threw that refusal straight out of a function whose return
  // type promises failures rather than exceptions.
  let totalCents: number
  try {
    totalCents = addCents(...coverCents)
  } catch (error) {
    failures.push({
      code: "INVALID_VALUE",
      ruleType: "MAX_TOTAL_COVER",
      ruleId: resolved.rule.id,
      lifeScope: resolved.rule.lifeScope,
      lifeRef: null,
      lifeType,
      limit: null,
      value: null,
      detail: `The total cover of these lives cannot be screened: ${(error as Error).message}`,
    })
    return
  }

  const limitCents = ruleLimitCents(resolved, "MAX_TOTAL_COVER", null, failures, lifeType)
  if (limitCents === null || totalCents <= limitCents) return

  const subject = lifeType ? `Total ${lifeType} cover` : "Total cover"
  failures.push({
    code: "MAX_TOTAL_COVER",
    ruleType: "MAX_TOTAL_COVER",
    ruleId: resolved.rule.id,
    lifeScope: resolved.rule.lifeScope,
    lifeRef: null,
    lifeType,
    limit: formatCents(limitCents),
    value: formatCents(totalCents),
    detail: `${subject} of ${formatCents(totalCents)} exceeds the maximum of ${formatCents(limitCents)}`,
  })
}
