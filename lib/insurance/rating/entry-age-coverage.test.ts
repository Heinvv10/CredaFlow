import { describe, expect, it } from "vitest"
import type { EligibilityLifeScope, EligibilityRuleType } from "@prisma/client"
import { entryAgeMismatches } from "./entry-age-coverage"
import type { GridBand } from "./band-grid"
import type { EligibilityRuleInput } from "../eligibility/failures"

let seq = 0
function rule(
  ruleType: EligibilityRuleType,
  lifeScope: EligibilityLifeScope,
  numericValue: number | null,
  active = true
): EligibilityRuleInput {
  seq += 1
  return { id: `r${seq}`, ruleType, lifeScope, numericValue, active }
}

function band(
  id: string,
  lifeType: GridBand["lifeType"],
  minAge: number,
  maxAge: number,
  sumAssured = 10000,
  premiumAmount = 45
): GridBand {
  return { id, lifeType, minAge, maxAge, sumAssured, premiumAmount }
}

/** A card banded 18-65 for a main member, across two NON-uniform age bands. */
const CARD_18_65: GridBand[] = [
  band("a", "MAIN_MEMBER", 18, 40),
  band("b", "MAIN_MEMBER", 41, 65, 10000, 88),
]

describe("entryAgeMismatches", () => {
  it("says nothing when the card covers exactly the ages the insurer accepts", () => {
    const rules = [rule("MIN_ENTRY_AGE", "ALL_LIVES", 18), rule("MAX_ENTRY_AGE", "ALL_LIVES", 65)]
    expect(entryAgeMismatches("AGE_BANDED", CARD_18_65, rules)).toEqual([])
  })

  it("says nothing when the card covers MORE than the insurer accepts", () => {
    // A card priced 18-65 under a max entry age of 60 is not a fault: ages
    // 61-65 are simply never quoted. Only the other direction strands a life.
    const rules = [rule("MIN_ENTRY_AGE", "ALL_LIVES", 21), rule("MAX_ENTRY_AGE", "ALL_LIVES", 60)]
    expect(entryAgeMismatches("AGE_BANDED", CARD_18_65, rules)).toEqual([])
  })

  it("names the ages a too-high MAX_ENTRY_AGE strands", () => {
    const rules = [rule("MAX_ENTRY_AGE", "ALL_LIVES", 70)]
    const found = entryAgeMismatches("AGE_BANDED", CARD_18_65, rules)
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({
      lifeType: "MAIN_MEMBER",
      ruleType: "MAX_ENTRY_AGE",
      ruleAge: 70,
      cardAge: 65,
    })
    expect(found[0].detail).toContain("Ages 66-70")
    expect(found[0].detail).toContain("screen as eligible and then fail to price")
  })

  it("names the ages a too-low MIN_ENTRY_AGE strands", () => {
    const rules = [rule("MIN_ENTRY_AGE", "ALL_LIVES", 16)]
    const found = entryAgeMismatches("AGE_BANDED", CARD_18_65, rules)
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ ruleType: "MIN_ENTRY_AGE", ruleAge: 16, cardAge: 18 })
    expect(found[0].detail).toContain("Ages 16-17")
  })

  it("reports both ends when the card is narrower at both", () => {
    const rules = [rule("MIN_ENTRY_AGE", "ALL_LIVES", 16), rule("MAX_ENTRY_AGE", "ALL_LIVES", 70)]
    expect(entryAgeMismatches("AGE_BANDED", CARD_18_65, rules).map((m) => m.ruleType)).toEqual([
      "MIN_ENTRY_AGE",
      "MAX_ENTRY_AGE",
    ])
  })

  it("measures the card's OUTER reach, not one band's", () => {
    // The 41-65 band is what makes 65 reachable; checking only the first band
    // would report a mismatch against 40.
    const rules = [rule("MAX_ENTRY_AGE", "ALL_LIVES", 65)]
    expect(entryAgeMismatches("AGE_BANDED", CARD_18_65, rules)).toEqual([])
  })

  it("resolves the rule per life type, so a scoped rule overrides ALL_LIVES", () => {
    // Children are accepted to 21 and the child card stops at 21 — no fault —
    // while the ALL_LIVES 65 still applies to the main member card.
    const rules = [
      rule("MAX_ENTRY_AGE", "ALL_LIVES", 65),
      rule("MAX_ENTRY_AGE", "CHILD", 21),
    ]
    const bands = [...CARD_18_65, band("c", "CHILD", 0, 21, 5000, 12.5)]
    expect(entryAgeMismatches("AGE_BANDED", bands, rules)).toEqual([])
  })

  it("uses the SCOPED rule even when it is the more generous one", () => {
    // The defect this guards: reading the ALL_LIVES row for every life type
    // would compare the child card against 65 and miss that the CHILD term
    // itself reaches past what the card prices.
    const rules = [rule("MAX_ENTRY_AGE", "ALL_LIVES", 21), rule("MAX_ENTRY_AGE", "CHILD", 25)]
    const found = entryAgeMismatches("AGE_BANDED", [band("c", "CHILD", 0, 21, 5000, 12.5)], rules)
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ lifeType: "CHILD", ruleAge: 25, cardAge: 21 })
  })

  it("ignores a life type the card carries no band for", () => {
    // That is a whole-life-type fault, reported once by the grid as
    // `unpriceableLifeTypes`. Reporting it again here as an age mismatch would
    // bury the simpler statement under a derived one.
    const rules = [rule("MAX_ENTRY_AGE", "ALL_LIVES", 70)]
    const found = entryAgeMismatches("AGE_BANDED", [band("c", "CHILD", 0, 21, 5000, 12.5)], rules)
    expect(found.map((m) => m.lifeType)).toEqual(["CHILD"])
  })

  it("ignores an INACTIVE rule, as screening does", () => {
    const rules = [rule("MAX_ENTRY_AGE", "ALL_LIVES", 70, false)]
    expect(entryAgeMismatches("AGE_BANDED", CARD_18_65, rules)).toEqual([])
  })

  it("ignores a rule with no value rather than comparing against NaN", () => {
    const rules = [rule("MAX_ENTRY_AGE", "ALL_LIVES", null)]
    expect(entryAgeMismatches("AGE_BANDED", CARD_18_65, rules)).toEqual([])
  })

  it("says nothing under FLAT, where age is not a rating factor", () => {
    // Every age matches the same band, so there is no age the card fails to
    // reach — the disagreement does not exist under this basis.
    const rules = [rule("MIN_ENTRY_AGE", "ALL_LIVES", 16), rule("MAX_ENTRY_AGE", "ALL_LIVES", 70)]
    expect(entryAgeMismatches("FLAT", CARD_18_65, rules)).toEqual([])
  })

  it("still checks PER_MILLE, which does rate on age", () => {
    const rules = [rule("MAX_ENTRY_AGE", "ALL_LIVES", 70)]
    expect(entryAgeMismatches("PER_MILLE", CARD_18_65, rules)).toHaveLength(1)
  })

  it("says nothing when no entry-age rule is captured yet", () => {
    // Missing mandatory rules are the eligibility screen's report, not this one.
    expect(entryAgeMismatches("AGE_BANDED", CARD_18_65, [])).toEqual([])
  })
})
