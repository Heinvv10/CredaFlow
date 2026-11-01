import { describe, expect, it } from "vitest"
import { keyFactsReferral, withKeyFactsReferral } from "./key-facts-referral"
import { facts } from "./facts.test-helpers"
import type { RuleDef, Verdict } from "./types"

const rule = (field: string, op = "lt", value: number | boolean = 560): RuleDef =>
  ({ id: "r1", name: "R1", outcome: "KNOCK_OUT", reasonCode: "R_ONE", declineCategory: "POLICY", when: { field, op, value } }) as RuleDef

describe("keyFactsReferral", () => {
  it("never refers an NCA_PASQ application (the staff approval path refuses a missing bureau itself)", () => {
    expect(keyFactsReferral({ regime: "NCA_PASQ", bureauCheckId: null, facts: facts({ bureauScore: null }), rules: [rule("bureauScore")] })).toBeNull()
  })

  it("refers a KEY_FACTS application with no bureau check: its bureau rules passed because they never fired", () => {
    expect(keyFactsReferral({ regime: "KEY_FACTS", bureauCheckId: null, facts: facts({ bureauScore: null }), rules: [] })).toEqual({ reasonCode: "NO_BUREAU", note: expect.stringContaining("bureau") })
  })

  it("refers a KEY_FACTS application when a rule compares a fact that is missing, even with a bureau check", () => {
    const result = keyFactsReferral({ regime: "KEY_FACTS", bureauCheckId: "chk", facts: facts({ bureauScore: 640, instalmentCents: null }), rules: [rule("bureauScore"), rule("instalmentCents", "gt", 1)] })
    expect(result).toEqual({ reasonCode: "MISSING_FACT", note: expect.stringContaining("instalmentCents") })
  })

  it("lets a rule test for a missing fact on purpose (isNull / notNull) and passes when every compared fact is known", () => {
    const isNull = { id: "r2", name: "R2", outcome: "REFER", reasonCode: "R_TWO", when: { field: "bureauScore", op: "isNull" } } as RuleDef
    expect(keyFactsReferral({ regime: "KEY_FACTS", bureauCheckId: "chk", facts: facts({ bureauScore: null }), rules: [isNull] })).toBeNull()
    expect(keyFactsReferral({ regime: "KEY_FACTS", bureauCheckId: "chk", facts: facts({ bureauScore: 640 }), rules: [rule("bureauScore")] })).toBeNull()
  })

  it("does not count a notNull test as a compared fact: a rule that asks whether the fact exists has its answer", () => {
    const notNull = { id: "r3", name: "R3", outcome: "REFER", reasonCode: "R_THREE", when: { field: "bureauScore", op: "notNull" } } as RuleDef
    expect(keyFactsReferral({ regime: "KEY_FACTS", bureauCheckId: "chk", facts: facts({ bureauScore: null }), rules: [notNull] })).toBeNull()
  })

  it("looks inside all/any groups", () => {
    const grouped = { id: "g", name: "G", outcome: "REFER", reasonCode: "G", when: { all: [{ any: [{ field: "bureauScore", op: "lt", value: 500 }] }] } } as RuleDef
    expect(keyFactsReferral({ regime: "KEY_FACTS", bureauCheckId: "chk", facts: facts({ bureauScore: null }), rules: [grouped] })).toMatchObject({ reasonCode: "MISSING_FACT" })
  })
})

describe("withKeyFactsReferral", () => {
  const graded: Verdict = { decision: "APPROVE", reasonCodes: ["RULES_PASSED"], declineCategory: null, riskGrade: "A", gradeRank: 0, score: 700, pricingTier: "T1", limitCapCents: null, hits: [] }
  const noBureau = { regime: "KEY_FACTS", bureauCheckId: null, facts: facts({ bureauScore: null }), rules: [] }
  const noGrade = { riskGrade: null, gradeRank: null, score: null, pricingTier: null }

  it("refers an approval and strips the grade: a graded row leaves the matrix's ungraded rule and enters risk pricing", () => {
    expect(withKeyFactsReferral(graded, noBureau)).toEqual({
      verdict: { ...graded, ...noGrade, decision: "REFER", reasonCodes: ["NO_BUREAU"] },
      note: expect.stringContaining("bureau"),
    })
  })

  it("keeps a decline a decline, with its reasons and category, and strips the grade", () => {
    const decline: Verdict = { ...graded, decision: "DECLINE", reasonCodes: ["R_ONE"], declineCategory: "POLICY" }
    expect(withKeyFactsReferral(decline, noBureau)).toEqual({ verdict: { ...decline, ...noGrade }, note: null })
  })

  it("keeps a rule's own referral and its reasons, and strips the grade", () => {
    const refer: Verdict = { ...graded, decision: "REFER", reasonCodes: ["R_TWO"] }
    expect(withKeyFactsReferral(refer, noBureau)).toEqual({ verdict: { ...refer, ...noGrade }, note: null })
  })

  it("leaves an NCA_PASQ verdict exactly as it is, and a key-facts one with every fact known", () => {
    expect(withKeyFactsReferral(graded, { ...noBureau, regime: "NCA_PASQ" })).toEqual({ verdict: graded, note: null })
    expect(withKeyFactsReferral(graded, { ...noBureau, bureauCheckId: "chk", facts: facts({ bureauScore: 640 }) })).toEqual({ verdict: graded, note: null })
  })
})
