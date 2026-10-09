// Where the rate card and the entry-age rules disagree.
//
// These are two different screens editing two different tables, and nothing
// compares them. A card banded 18-65 sitting under a MAX_ENTRY_AGE of 70 is
// individually valid on both sides: the eligibility screen shows a captured
// insurer term, the rate screen shows a contiguous card with no gap and no
// overlap. Together they say a 68-year-old is eligible and cannot be priced —
// `evaluate` passes the life, `rateLife` returns NO_MATCHING_BAND, and the
// first person to find out is a staff member mid-quote.
//
// It is deliberately NOT reported as a gap in the card. A minimum entry age is
// an eligibility rule, not a hole: a card that starts at 18 is not missing ages
// 0-17, and calling it a gap would put a warning on every column of every
// correct card. What is wrong is only the DISAGREEMENT, so that is what this
// names, in both directions.
//
// PURE: no Prisma, no I/O, no `new Date()`.

import type { InsuredLifeType, RateBasis } from "@prisma/client"
import { bandMatchAxes, INSURED_LIFE_TYPES } from "./band-match"
import { resolveRule } from "../eligibility/rule-resolution"
import type { EligibilityRuleInput } from "../eligibility/failures"
import type { GridBand } from "./band-grid"

export interface EntryAgeMismatch {
  lifeType: InsuredLifeType
  /** Which rule the card fails to reach. */
  ruleType: "MIN_ENTRY_AGE" | "MAX_ENTRY_AGE"
  /** The age the rule allows. */
  ruleAge: number
  /** The furthest age the card actually prices in that direction. */
  cardAge: number
  detail: string
}

/**
 * The entry ages an insurer accepts that this card cannot price.
 *
 * Only life types the card HAS bands for are checked. One with no band at all
 * is a whole other fault — `BandGrid.unpriceableLifeTypes` — and reporting it
 * twice, once as "no band" and once as "does not reach age 18", would bury the
 * simpler statement under the derived one.
 *
 * A basis that does not rate on age is skipped entirely. Under FLAT every age
 * matches the same band, so there is no age the card fails to reach and no
 * disagreement to report.
 */
export function entryAgeMismatches(
  basis: RateBasis,
  bands: readonly GridBand[],
  rules: EligibilityRuleInput[]
): EntryAgeMismatch[] {
  if (!bandMatchAxes(basis).age) return []

  const mismatches: EntryAgeMismatch[] = []

  for (const lifeType of INSURED_LIFE_TYPES) {
    const own = bands.filter((band) => band.lifeType === lifeType)
    if (own.length === 0) continue

    const cardMin = Math.min(...own.map((band) => band.minAge))
    const cardMax = Math.max(...own.map((band) => band.maxAge))

    // Resolved through `resolveRule` — the same resolution screening uses, so a
    // rule scoped to this life type overrides ALL_LIVES here exactly as it will
    // when a real quote is screened. Reading the rows directly would compare
    // the card against a term that does not apply to it.
    const min = resolveRule(rules, "MIN_ENTRY_AGE", lifeType)
    if (min.status === "OK") {
      const ruleAge = Number(min.numericValue)
      if (Number.isFinite(ruleAge) && ruleAge < cardMin) {
        mismatches.push({
          lifeType,
          ruleType: "MIN_ENTRY_AGE",
          ruleAge,
          cardAge: cardMin,
          detail: `${lifeType}: entry is allowed from age ${ruleAge}, but the card prices nothing below ${cardMin}. Ages ${ruleAge}-${cardMin - 1} would screen as eligible and then fail to price.`,
        })
      }
    }

    const max = resolveRule(rules, "MAX_ENTRY_AGE", lifeType)
    if (max.status === "OK") {
      const ruleAge = Number(max.numericValue)
      if (Number.isFinite(ruleAge) && ruleAge > cardMax) {
        mismatches.push({
          lifeType,
          ruleType: "MAX_ENTRY_AGE",
          ruleAge,
          cardAge: cardMax,
          detail: `${lifeType}: entry is allowed up to age ${ruleAge}, but the card prices nothing above ${cardMax}. Ages ${cardMax + 1}-${ruleAge} would screen as eligible and then fail to price.`,
        })
      }
    }
  }

  return mismatches
}
