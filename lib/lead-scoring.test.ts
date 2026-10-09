import { describe, it, expect } from "vitest"
import { calculateLeadScore, getScoreTier, leadQueuePriority, type LeadWithFinancials } from "./lead-scoring"

// Minimal factory — only the fields the scorer reads. Cast keeps the test
// readable without constructing every Lead column.
function lead(overrides: Partial<LeadWithFinancials> = {}): LeadWithFinancials {
  return {
    source: "MANUAL",
    employmentType: null,
    declaredIncome: null,
    requestedAmount: null,
    createdAt: new Date(), // fresh (≤1 day) unless overridden
    _count: { activities: 0 },
    ...overrides,
  } as unknown as LeadWithFinancials
}

const STALE = new Date("2020-01-01T00:00:00Z") // always > 14 days old → 0 freshness

describe("calculateLeadScore", () => {
  it("pins the baseline lead (missing financials, default employment, manual, fresh, no activity)", () => {
    // 15 affordability(missing) + 10 employment(default) + 5 source(manual) + 15 freshness(≤1d) + 0 activity
    expect(calculateLeadScore(lead())).toBe(45)
  })

  it("pins a top-tier lead at the 100 clamp", () => {
    // 30 + 20 + 25 + 15 + 10 = 100
    expect(
      calculateLeadScore(
        lead({
          source: "REFERRAL",
          employmentType: "SALARIED",
          declaredIncome: 10_000,
          requestedAmount: 2_000, // ratio 0.2 → excellent
          _count: { activities: 3 },
        }),
      ),
    ).toBe(100)
  })

  it("pins a poor, stale, unemployed lead", () => {
    // 0 affordability(ratio 0.9) + 0 employment(unemployed) + 5 source(manual) + 0 freshness(stale) + 0 activity
    expect(
      calculateLeadScore(
        lead({
          employmentType: "UNEMPLOYED",
          declaredIncome: 10_000,
          requestedAmount: 9_000,
          createdAt: STALE,
        }),
      ),
    ).toBe(5)
  })

  it("credits a mid lead (good affordability, self-employed, website, 5 days old, one activity)", () => {
    // 20 + 12 + 15 + 8 + 5 = 60
    const fiveDaysAgo = new Date(Date.now() - 5 * 86_400_000)
    expect(
      calculateLeadScore(
        lead({
          source: "WEBSITE",
          employmentType: "SELF_EMPLOYED",
          declaredIncome: 10_000,
          requestedAmount: 4_000, // ratio 0.4 → good
          createdAt: fiveDaysAgo,
          _count: { activities: 1 },
        }),
      ),
    ).toBe(60)
  })
})

describe("getScoreTier", () => {
  it("maps scores to the right tier at every boundary", () => {
    expect(getScoreTier(80).label).toBe("HOT")
    expect(getScoreTier(79).label).toBe("WARM")
    expect(getScoreTier(60).label).toBe("WARM")
    expect(getScoreTier(59).label).toBe("COOL")
    expect(getScoreTier(40).label).toBe("COOL")
    expect(getScoreTier(39).label).toBe("COLD")
  })
})

describe("leadQueuePriority", () => {
  const now = new Date("2026-01-15T00:00:00Z").getTime()
  const daysAgo = (d: number) => new Date(now - d * 86_400_000)

  it("equals the score for a lead touched just now", () => {
    expect(leadQueuePriority(60, daysAgo(0), now)).toBe(60)
  })

  it("doubles at 7 days untouched and triples at 14", () => {
    expect(leadQueuePriority(60, daysAgo(7), now)).toBe(120)
    expect(leadQueuePriority(60, daysAgo(14), now)).toBe(180)
  })

  it("lets a merely-good but stale lead outrank a hot but freshly-worked one", () => {
    const staleGood = leadQueuePriority(50, daysAgo(14), now) // 50 * 3 = 150
    const freshHot = leadQueuePriority(80, daysAgo(0), now) // 80
    expect(staleGood).toBeGreaterThan(freshHot)
  })

  it("never treats a future updatedAt as negative staleness", () => {
    expect(leadQueuePriority(60, new Date(now + 86_400_000), now)).toBe(60)
  })
})
