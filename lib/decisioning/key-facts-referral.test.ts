import { describe, expect, it } from "vitest"
import { keyFactsReferral, withKeyFactsAttestation, withKeyFactsReferral } from "./key-facts-referral"
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

  it("refers a scorecard decline with no bureau check: a score built on missing facts declines nobody", () => {
    const onScore: Verdict = { ...graded, decision: "DECLINE", reasonCodes: ["SCORE_BELOW_CUTOFF"], declineCategory: "BUREAU_SCORE" }
    expect(withKeyFactsReferral(onScore, noBureau)).toEqual({
      verdict: { ...onScore, ...noGrade, decision: "REFER", reasonCodes: ["NO_BUREAU"], declineCategory: null },
      note: expect.stringContaining("decline it on a score"),
    })
  })

  it("keeps a scorecard decline when a bureau check exists: only a missing fact the rules compare refers it, and that is not the score's fault", () => {
    const onScore: Verdict = { ...graded, decision: "DECLINE", reasonCodes: ["SCORE_BELOW_CUTOFF"], declineCategory: "BUREAU_SCORE" }
    const missing = { regime: "KEY_FACTS", bureauCheckId: "chk", facts: facts({ bureauScore: null }), rules: [rule("bureauScore")] }
    expect(withKeyFactsReferral(onScore, missing)).toEqual({ verdict: { ...onScore, ...noGrade }, note: null })
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

describe("withKeyFactsAttestation", () => {
  const approve: Verdict = { decision: "APPROVE", reasonCodes: ["RULES_PASSED"], declineCategory: null, riskGrade: "A", gradeRank: 0, score: 700, pricingTier: "T1", limitCapCents: null, hits: [] }
  const digital = { regime: "KEY_FACTS", allowed: true, trigger: "DIGITAL_SUBMISSION", facts: facts({ channel: "PORTAL", affordabilityGatePasses: true, expensesBelowMinimum: false }) }

  it("attests a digital key-facts approval on a passing affordability gate, and leaves the verdict as it is", () => {
    expect(withKeyFactsAttestation(approve, digital)).toEqual({ verdict: approve, note: null, attested: true })
  })

  it("never attests an NCA_PASQ application, whatever the setting says: it needs a person's s81 assessment", () => {
    expect(withKeyFactsAttestation(approve, { ...digital, regime: "NCA_PASQ" })).toEqual({ verdict: approve, note: null, attested: false })
    expect(withKeyFactsAttestation(approve, { ...digital, regime: null })).toEqual({ verdict: approve, note: null, attested: false })
  })

  it("refers while the lender has not switched it on (the default), keeping the grade: this applicant was bureau-checked", () => {
    const { verdict, attested, note } = withKeyFactsAttestation(approve, { ...digital, allowed: false })
    expect(attested).toBe(false)
    expect(verdict).toEqual({ ...approve, decision: "REFER", reasonCodes: ["KEY_FACTS_INSTANT_APPROVAL_OFF"] })
    expect(note).toContain("instant approval")
  })

  it.each([
    ["a person pressed the button", { trigger: "MANUAL" }],
    ["staff started the review", { trigger: "REVIEW_STARTED" }],
    ["staff captured it", { facts: facts({ channel: "STAFF", affordabilityGatePasses: true, expensesBelowMinimum: false }) }],
  ])("refers an application that is not a digital submission: %s", (_label, over) => {
    expect(withKeyFactsAttestation(approve, { ...digital, ...over })).toMatchObject({ attested: false, verdict: { decision: "REFER", reasonCodes: ["NOT_A_DIGITAL_SUBMISSION"] } })
  })

  it.each([
    ["the gate failed", { affordabilityGatePasses: false, expensesBelowMinimum: false }],
    ["the instalment could not be priced", { affordabilityGatePasses: null, expensesBelowMinimum: false }],
    ["expenses are below the minimum: a person must justify them", { affordabilityGatePasses: true, expensesBelowMinimum: true }],
  ])("does not attest what it cannot stand behind, it refers: %s", (_label, over) => {
    expect(withKeyFactsAttestation(approve, { ...digital, facts: facts({ channel: "PORTAL", ...over }) })).toMatchObject({ attested: false, verdict: { decision: "REFER", reasonCodes: ["AFFORDABILITY_NOT_ATTESTED"] } })
  })

  it("leaves a decline and a referral alone: only an approval needs the attestation", () => {
    const decline: Verdict = { ...approve, decision: "DECLINE", reasonCodes: ["R_ONE"], declineCategory: "POLICY" }
    const refer: Verdict = { ...approve, decision: "REFER", reasonCodes: ["NO_BUREAU"] }
    expect(withKeyFactsAttestation(decline, { ...digital, allowed: false })).toEqual({ verdict: decline, note: null, attested: false })
    expect(withKeyFactsAttestation(refer, digital)).toEqual({ verdict: refer, note: null, attested: false })
  })
})
