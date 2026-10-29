import { describe, expect, it } from "vitest"
import { facts } from "./facts.test-helpers"
import { scoreApplication } from "./scorecard"
import type { Scorecard } from "./types"

const card: Scorecard = {
  baseScore: 100,
  characteristics: [
    { field: "bureauScore", missingPoints: -40, bins: [{ max: 500, points: -50 }, { min: 500, max: 600, points: 0 }, { min: 600, points: 60 }] },
    { field: "employmentStatus", missingPoints: -10, bins: [{ in: ["EMPLOYED"], points: 30 }, { equals: "STUDENT", points: -20 }] },
    { field: "isRepeatClient", missingPoints: 0, bins: [{ equals: true, points: 25 }, { equals: false, points: 0 }] },
  ],
  bands: [
    { minScore: 180, grade: "A", action: "ALLOW", pricingTier: "PRIME" },
    { minScore: 140, grade: "B", action: "ALLOW", pricingTier: "STANDARD" },
    { minScore: 100, grade: "C", action: "REFER" },
    { minScore: 0, grade: "D", action: "DECLINE", declineCategory: "BUREAU_SCORE" },
  ],
}

describe("scoreApplication", () => {
  it("adds the base score and the points of the bin each fact falls in", () => {
    const r = scoreApplication(card, facts({ bureauScore: 640, employmentStatus: "EMPLOYED", isRepeatClient: false }))
    expect(r.score).toBe(190)
    expect(r.grade).toBe("A")
    expect(r.pricingTier).toBe("PRIME")
    expect(r.breakdown).toEqual([
      { field: "bureauScore", points: 60 }, { field: "employmentStatus", points: 30 }, { field: "isRepeatClient", points: 0 },
    ])
  })

  it("numeric bins are min-inclusive and max-exclusive", () => {
    expect(scoreApplication(card, facts({ bureauScore: 600 })).breakdown[0].points).toBe(60)
    expect(scoreApplication(card, facts({ bureauScore: 599 })).breakdown[0].points).toBe(0)
    expect(scoreApplication(card, facts({ bureauScore: 500 })).breakdown[0].points).toBe(0)
    expect(scoreApplication(card, facts({ bureauScore: 499 })).breakdown[0].points).toBe(-50)
  })

  it("a missing fact, or one in no bin, scores the characteristic's missing points", () => {
    expect(scoreApplication(card, facts({ bureauScore: null })).breakdown[0].points).toBe(-40)
    expect(scoreApplication(card, facts({ employmentStatus: "PENSIONER" })).breakdown[1].points).toBe(-10)
  })

  it("maps the total to the highest band whose minimum it reaches, and the lowest band catches the rest", () => {
    expect(scoreApplication(card, facts({ bureauScore: 640, employmentStatus: "EMPLOYED" })).grade).toBe("A")
    const b = scoreApplication(card, facts({ bureauScore: 599, employmentStatus: "EMPLOYED", isRepeatClient: true }))
    expect(b.score).toBe(155)
    expect(b.grade).toBe("B")
    const c = scoreApplication(card, facts({ bureauScore: 599, employmentStatus: "EMPLOYED" }))
    expect(c.grade).toBe("C")
    expect(c.action).toBe("REFER")
    const worst = scoreApplication(card, facts({ bureauScore: 400, employmentStatus: "STUDENT" }))
    expect(worst.score).toBe(30)
    expect(worst.grade).toBe("D")
    expect(worst.action).toBe("DECLINE")
    expect(worst.declineCategory).toBe("BUREAU_SCORE")
    expect(scoreApplication(card, facts({ bureauScore: null, employmentStatus: null })).score).toBe(50)
  })
})
