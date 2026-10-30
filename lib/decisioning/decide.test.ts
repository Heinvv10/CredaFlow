import { describe, expect, it } from "vitest"
import { decide } from "./decide"
import { facts } from "./facts.test-helpers"
import type { RuleDef, Scorecard } from "./types"

const knock: RuleDef = { id: "judg", name: "Judgement", outcome: "KNOCK_OUT", reasonCode: "BUREAU_JUDGEMENT", declineCategory: "ADVERSE_LISTING", when: { field: "bureauJudgement", op: "eq", value: true } }
const refer: RuleDef = { id: "no-bureau", name: "No bureau", outcome: "REFER", reasonCode: "NO_BUREAU", when: { field: "bureauAvailable", op: "eq", value: false } }
const cap: RuleDef = { id: "new-cap", name: "New client cap", outcome: "LIMIT_CAP", reasonCode: "NEW_CLIENT_CAP", limitCapCents: 200_000, when: { field: "isRepeatClient", op: "eq", value: false } }
const card: Scorecard = {
  baseScore: 0,
  characteristics: [{ field: "bureauScore", missingPoints: 0, bins: [{ max: 500, points: 10 }, { min: 500, points: 100 }] }],
  bands: [
    { minScore: 100, grade: "A", action: "ALLOW", pricingTier: "PRIME" },
    { minScore: 50, grade: "B", action: "REFER" },
    { minScore: 0, grade: "C", action: "DECLINE" },
  ],
}

describe("decide", () => {
  it("approves with the rules-passed reason code when nothing fires", () => {
    const v = decide({ facts: facts(), rules: [knock, refer], scorecard: null })
    expect(v).toMatchObject({ decision: "APPROVE", reasonCodes: ["RULES_PASSED"], riskGrade: null, score: null, declineCategory: null })
  })

  it("a knock-out declines with every knock-out code and the first one's category", () => {
    const v = decide({ facts: facts({ bureauJudgement: true, bureauAvailable: false }), rules: [refer, knock], scorecard: null })
    expect(v.decision).toBe("DECLINE")
    expect(v.reasonCodes).toEqual(["BUREAU_JUDGEMENT"])
    expect(v.declineCategory).toBe("ADVERSE_LISTING")
  })

  it("a knock-out outranks a refer and a good score", () => {
    const v = decide({ facts: facts({ bureauJudgement: true, bureauScore: 700 }), rules: [knock], scorecard: card })
    expect(v.decision).toBe("DECLINE")
    expect(v.riskGrade).toBe("A")
  })

  it("a refer rule refers, with its code", () => {
    const v = decide({ facts: facts({ bureauAvailable: false }), rules: [refer, cap], scorecard: null })
    expect(v.decision).toBe("REFER")
    expect(v.reasonCodes).toContain("NO_BUREAU")
  })

  it("a limit cap below the requested amount refers; at or above it approves", () => {
    const over = decide({ facts: facts({ requestedAmountCents: 300_000 }), rules: [cap], scorecard: null })
    expect(over).toMatchObject({ decision: "REFER", limitCapCents: 200_000 })
    expect(over.reasonCodes).toEqual(["NEW_CLIENT_CAP", "LIMIT_EXCEEDED"])
    expect(decide({ facts: facts({ requestedAmountCents: 200_000 }), rules: [cap], scorecard: null }).decision).toBe("APPROVE")
  })

  it("the lowest of several caps applies", () => {
    const tighter: RuleDef = { ...cap, id: "tight", reasonCode: "TIGHT", limitCapCents: 100_000 }
    expect(decide({ facts: facts(), rules: [cap, tighter], scorecard: null }).limitCapCents).toBe(100_000)
  })

  it("the scorecard grades the application and its band can allow, refer or decline", () => {
    const a = decide({ facts: facts({ bureauScore: 640 }), rules: [], scorecard: card })
    expect(a).toMatchObject({ decision: "APPROVE", riskGrade: "A", score: 100, pricingTier: "PRIME" })
    const c = decide({ facts: facts({ bureauScore: 400 }), rules: [], scorecard: card })
    expect(c).toMatchObject({ decision: "DECLINE", riskGrade: "C", reasonCodes: ["SCORE_BELOW_CUTOFF"], declineCategory: "POLICY" })
    const refBand: Scorecard = { ...card, characteristics: [{ field: "bureauScore", missingPoints: 0, bins: [{ min: 0, points: 60 }] }] }
    const b = decide({ facts: facts(), rules: [], scorecard: refBand })
    expect(b).toMatchObject({ decision: "REFER", riskGrade: "B", reasonCodes: ["SCORE_REFER_BAND"] })
  })

  it("every verdict names at least one reason code", () => {
    for (const f of [facts(), facts({ bureauJudgement: true }), facts({ bureauAvailable: false })]) {
      expect(decide({ facts: f, rules: [knock, refer], scorecard: card }).reasonCodes.length).toBeGreaterThan(0)
    }
  })
})
