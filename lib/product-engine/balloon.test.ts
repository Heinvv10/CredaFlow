import { describe, expect, it } from "vitest"
import { monthlyEquivalentInstalment } from "./instalment"
import { generateSchedule } from "./schedule"
import { parseProductConfig } from "./terms"
import type { RepaymentTerms } from "./types"

const startDate = new Date("2027-03-10T08:00:00+02:00")
const balloon = (over: Partial<RepaymentTerms> = {}): RepaymentTerms => ({ frequency: "MONTHLY", structure: "BALLOON", graceKind: "NONE", graceInstalments: 0, instalments: 12, balloonPct: 0.3, ...over })
const run = (principalCents: number, interestRatePm: number, terms: RepaymentTerms, interestModel: "REDUCING_BALANCE" | "FLAT" = "REDUCING_BALANCE", monthlyServiceFeeCents = 0) =>
  generateSchedule({ principalCents, interestRatePm, interestModel, monthlyServiceFeeCents, startDate, terms })

describe("a balloon schedule", () => {
  it("amortises down to the balloon and pays it with the last instalment", () => {
    const { schedule, totalInterest } = run(10_000_000, 0.02, balloon())
    expect(schedule).toHaveLength(12)
    const last = schedule[11]!
    // Everything before the last row leaves exactly the balloon: the last row's principal is the balloon plus its own share.
    expect(schedule[10]!.closingBalance).toBeGreaterThan(3_000_000)
    expect(last.principalDue).toBeGreaterThan(3_000_000)
    expect(last.closingBalance).toBe(0)
    // Equal instalments on the rows before it.
    const regular = schedule.slice(0, 11).map((r) => r.totalDue)
    expect(Math.max(...regular) - Math.min(...regular)).toBeLessThanOrEqual(1)
    expect(last.totalDue).toBeGreaterThan(regular[0]! + 2_900_000)
    expect(schedule.reduce((a, r) => a + r.principalDue, 0)).toBe(10_000_000)
    expect(schedule.reduce((a, r) => a + r.interestDue, 0)).toBe(totalInterest)
  })

  it("matches the standard balloon annuity: PMT on principal less the discounted balloon", () => {
    const r = 0.02
    const expected = Math.round(((10_000_000 - 3_000_000 / 1.02 ** 12) * r) / (1 - 1.02 ** -12))
    expect(run(10_000_000, r, balloon()).schedule[0]!.totalDue).toBe(expected)
  })

  it("on a flat rate charges interest on the original principal, evenly, and leaves the balloon to the last row", () => {
    const { schedule, totalInterest } = run(1_200_000, 0.02, balloon({ balloonPct: 0.25 }), "FLAT")
    expect(totalInterest).toBe(288_000)
    expect(schedule[0]!.principalDue).toBe(75_000)
    expect(schedule[11]!.principalDue).toBe(375_000)
    expect(schedule[0]!.interestDue).toBe(24_000)
  })

  it("is interest-free when the rate is 0, and still clears", () => {
    const { schedule } = run(1_200_000, 0, balloon({ balloonPct: 0.5 }))
    expect(schedule[0]!.principalDue).toBe(50_000)
    expect(schedule[11]!.principalDue).toBe(650_000)
    expect(schedule[11]!.closingBalance).toBe(0)
  })

  it.each([
    [10_000, 0.0001, 12, "MONTHLY"], [99_999, 0.05, 7, "WEEKLY"], [500_001, 0.33, 24, "FORTNIGHTLY"], [100, 0.9, 3, "MONTHLY"], [7_777_777, 0.0333, 60, "MONTHLY"],
  ] as const)("reconciles to the cent: principal %d, %d share", (principal, pct, instalments, frequency) => {
    for (const rate of [0, 0.0125, 0.05, 0.3]) {
      const { schedule, totalInterest } = run(principal, rate, balloon({ balloonPct: pct, instalments, frequency }))
      let balance = principal
      for (const row of schedule) {
        expect(row.principalDue).toBeGreaterThanOrEqual(0)
        expect(row.principalDue).toBeLessThanOrEqual(balance)
        balance -= row.principalDue
        expect(row.closingBalance).toBe(balance)
      }
      expect(balance).toBe(0)
      expect(schedule.reduce((a, r) => a + r.interestDue, 0)).toBe(totalInterest)
    }
  })

  it("refuses a balloon with no share, a share of 1 or more, one instalment, or a grace; and a share on any other structure", () => {
    expect(() => run(100_000, 0.02, balloon({ balloonPct: undefined }))).toThrow("balloon")
    expect(() => run(100_000, 0.02, balloon({ balloonPct: 1 }))).toThrow("balloon")
    expect(() => run(100_000, 0.02, balloon({ instalments: 1 }))).toThrow("balloon")
    expect(() => run(100_000, 0.02, balloon({ graceKind: "FULL", graceInstalments: 1 }))).toThrow("balloon")
    expect(() => run(100_000, 0.02, { ...balloon(), structure: "AMORTISING" })).toThrow("balloon")
  })

  it("sets affordability on the recurring instalment, not on the row that carries the balloon, and says so by weekly scaling it too", () => {
    const { schedule } = run(10_000_000, 0.02, balloon())
    expect(monthlyEquivalentInstalment(schedule, balloon())).toBe(schedule[1]!.totalDue)
    const weekly = run(10_000_000, 0.005, balloon({ frequency: "WEEKLY", instalments: 52 })).schedule
    expect(monthlyEquivalentInstalment(weekly, balloon({ frequency: "WEEKLY", instalments: 52 }))).toBe(Math.round((weekly[1]!.totalDue * 52) / 12))
  })
})

describe("a balloon in the product configuration", () => {
  const config = (repayment: unknown) => ({
    minAmountCents: 100_000, maxAmountCents: 800_000, minTermDays: 60, maxTermDays: 180, interestRatePm: 0.03, interestModel: "REDUCING_BALANCE", initiationFeeModel: "FLAT_PCT", initiationFeePct: 0.05,
    initiationFeeMaxCents: 100_000, monthlyServiceFeeCents: 6_900, repayment, collateral: [], eligibility: { minAge: null, maxAge: null, minMonthlyIncomeCents: null, minEmploymentMonths: null },
  })
  const spec = { frequency: "MONTHLY", structure: "BALLOON", graceKind: "NONE", graceInstalments: 0, balloonPct: 0.2 }

  it("keeps the share in the stored structure, and leaves it off every other", () => {
    expect(parseProductConfig(config(spec)).repayment).toEqual(spec)
    const amortising = parseProductConfig(config({ frequency: "MONTHLY", structure: "AMORTISING", graceKind: "NONE", graceInstalments: 0 })).repayment
    expect(amortising).not.toHaveProperty("balloonPct")
  })

  it("names each refusal", () => {
    const problems = (repayment: unknown) => {
      try {
        parseProductConfig(config(repayment))
        return ""
      } catch (error) {
        return (error as { problems: string[] }).problems.join(" | ")
      }
    }
    expect(problems({ ...spec, balloonPct: 0 })).toContain("repayment.balloonPct")
    expect(problems({ ...spec, balloonPct: 1 })).toContain("repayment.balloonPct")
    expect(problems({ ...spec, balloonPct: undefined })).toContain("repayment.balloonPct")
    expect(problems({ ...spec, structure: "AMORTISING" })).toContain("repayment.balloonPct")
    expect(problems({ ...spec, graceKind: "PRINCIPAL_ONLY", graceInstalments: 1 })).toContain("repayment")
    // The shortest term must leave a row before the balloon's.
    expect(problems({ ...spec, frequency: "MONTHLY" }).length).toBe(0)
    expect(problems(spec)).toBe("")
  })
})
