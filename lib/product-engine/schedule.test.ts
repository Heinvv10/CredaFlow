import { describe, expect, it } from "vitest"
import { calculateLoan } from "@/lib/loan-calculator"
import { addCalendarMonths, addPeriods } from "./periods"
import { generateSchedule, type ScheduleInput } from "./schedule"
import type { Frequency, GraceKind, RepaymentStructure } from "./types"

// Start: 10 Feb 2027, noon SAST. A day every month has, so calendar months fall on the same day.
const START = new Date("2027-02-10T12:00:00+02:00")

const input = (over: Omit<Partial<ScheduleInput>, "terms"> & { terms?: Partial<ScheduleInput["terms"]> } = {}): ScheduleInput => ({
  principalCents: 1_000_000,
  interestRatePm: 0.02,
  interestModel: "REDUCING_BALANCE",
  monthlyServiceFeeCents: 0,
  startDate: START,
  ...over,
  terms: { frequency: "MONTHLY", structure: "AMORTISING", graceKind: "NONE", graceInstalments: 0, instalments: 6, ...over.terms },
})

const rows = (i: ScheduleInput) => generateSchedule(i).schedule.map((r) => [r.principalDue, r.interestDue])

describe("amortising, reducing balance: hand-worked", () => {
  it("monthly R12 000 at 2% a month over 3 months: instalment 416 106, the last row clears the balance", () => {
    // PMT = 1 200 000 x 0.02 / (1 - 1.02^-3) = 416 106 (rounded); interest each month on what is left.
    const g = generateSchedule(input({ principalCents: 1_200_000, terms: { instalments: 3 } }))
    expect(g.schedule.map((r) => [r.principalDue, r.interestDue, r.openingBalance, r.closingBalance])).toEqual([
      [392_106, 24_000, 1_200_000, 807_894],
      [399_948, 16_158, 807_894, 407_946],
      [407_946, 8_159, 407_946, 0],
    ])
    expect(g.totalInterest).toBe(48_317)
  })

  it("weekly R1 000 at 4% a month over 4 weeks: the weekly rate is 4% x 12 / 52", () => {
    expect(rows(input({ principalCents: 100_000, interestRatePm: 0.04, terms: { frequency: "WEEKLY", instalments: 4 } }))).toEqual([
      [24_657, 923], [24_885, 695], [25_114, 466], [25_344, 234],
    ])
  })

  it("fortnightly flat: the interest is the monthly rate for the term, split evenly, principal split evenly", () => {
    // 300 000 x 5% x 12 x 3 / 26 = 20 769 over 3 fortnights
    const g = generateSchedule(input({ principalCents: 300_000, interestRatePm: 0.05, interestModel: "FLAT", terms: { frequency: "FORTNIGHTLY", instalments: 3 } }))
    expect(g.totalInterest).toBe(20_769)
    expect(g.schedule.map((r) => [r.principalDue, r.interestDue, r.totalDue])).toEqual([
      [100_000, 6_923, 106_923], [100_000, 6_923, 106_923], [100_000, 6_923, 106_923],
    ])
  })

  it("a zero rate splits the principal evenly and charges no interest", () => {
    expect(rows(input({ principalCents: 100_000, interestRatePm: 0, terms: { instalments: 3 } }))).toEqual([[33_333, 0], [33_333, 0], [33_334, 0]])
  })
})

describe("grace periods: hand-worked, 10 000.00 at 2% a month over 6 months with 2 of grace", () => {
  it("principal-only grace: interest only for 2 instalments, then the annuity of the whole principal over the other 4", () => {
    const g = generateSchedule(input({ terms: { graceKind: "PRINCIPAL_ONLY", graceInstalments: 2 } }))
    expect(g.schedule.map((r) => [r.principalDue, r.interestDue])).toEqual([
      [0, 20_000], [0, 20_000], [242_624, 20_000], [247_476, 15_148], [252_426, 10_198], [257_474, 5_149],
    ])
    expect(g.schedule.map((r) => r.dueDate.toISOString())).toEqual([
      "2027-03-10T10:00:00.000Z", "2027-04-10T10:00:00.000Z", "2027-05-10T10:00:00.000Z", "2027-06-10T10:00:00.000Z", "2027-07-10T10:00:00.000Z", "2027-08-10T10:00:00.000Z",
    ])
  })

  it("full grace: no rows for 2 periods; the 40 000 of interest meanwhile is deferred and spread over the 4 instalments, never compounded", () => {
    const g = generateSchedule(input({ terms: { graceKind: "FULL", graceInstalments: 2 } }))
    expect(g.schedule).toHaveLength(4)
    expect(g.schedule.map((r) => [r.principalDue, r.interestDue])).toEqual([
      [242_624, 30_000], [247_476, 25_148], [252_426, 20_198], [257_474, 15_149],
    ])
    // the first payment falls due after the grace: 3 months from the start, not 1
    expect(g.schedule[0]!.dueDate.toISOString()).toBe("2027-05-10T10:00:00.000Z")
    // 10 000.00 of principal; interest: the 4 instalments' own 50 495 plus the 40 000 deferred
    expect(g.totalInterest).toBe(15_148 + 10_198 + 5_149 + 20_000 + 40_000)
  })
})

describe("interest-only and bullet", () => {
  it("interest-only: the interest every month, the whole principal with the last instalment", () => {
    const g = generateSchedule(input({ terms: { structure: "INTEREST_ONLY" } }))
    expect(g.schedule.map((r) => [r.principalDue, r.interestDue])).toEqual([[0, 20_000], [0, 20_000], [0, 20_000], [0, 20_000], [0, 20_000], [1_000_000, 20_000]])
    expect(g.schedule.map((r) => r.closingBalance)).toEqual([1_000_000, 1_000_000, 1_000_000, 1_000_000, 1_000_000, 0])
  })

  it("bullet: one payment at the end of the term with all the interest (simple)", () => {
    const g = generateSchedule(input({ terms: { structure: "BULLET" } }))
    expect(g.schedule).toHaveLength(1)
    expect(g.schedule[0]).toMatchObject({ principalDue: 1_000_000, interestDue: 120_000, totalDue: 1_120_000, dueDate: addPeriods(START, "MONTHLY", 6) })
  })

  it("interest-only with a full grace defers the grace interest over the instalments that follow", () => {
    const g = generateSchedule(input({ terms: { structure: "INTEREST_ONLY", graceKind: "FULL", graceInstalments: 2 } }))
    // 4 instalments of 20 000 interest + 10 000 of the 40 000 deferred; principal with the last
    expect(g.schedule.map((r) => [r.principalDue, r.interestDue])).toEqual([[0, 30_000], [0, 30_000], [0, 30_000], [1_000_000, 30_000]])
  })

  it("bullet and interest-only refuse a principal-only grace: it would be the structure already", () => {
    expect(() => generateSchedule(input({ terms: { structure: "BULLET", graceKind: "PRINCIPAL_ONLY", graceInstalments: 1 } }))).toThrow(/grace/i)
    expect(() => generateSchedule(input({ terms: { structure: "INTEREST_ONLY", graceKind: "PRINCIPAL_ONLY", graceInstalments: 1 } }))).toThrow(/grace/i)
  })
})

describe("dates against the calendar", () => {
  it("weekly and fortnightly are exactly 7 and 14 days apart", () => {
    for (const [frequency, days] of [["WEEKLY", 7], ["FORTNIGHTLY", 14]] as const) {
      const dates = generateSchedule(input({ terms: { frequency, instalments: 8 } })).schedule.map((r) => r.dueDate.getTime())
      expect(dates[0]).toBe(START.getTime() + days * 86_400_000)
      for (let i = 1; i < dates.length; i++) expect(dates[i]! - dates[i - 1]!).toBe(days * 86_400_000)
    }
  })

  it("monthly keeps the day of the month and clamps to the month end: 31 Jan, 28 Feb, 31 Mar, 30 Apr", () => {
    const jan31 = new Date("2027-01-31T08:00:00+02:00")
    const dates = [1, 2, 3, 4].map((k) => addCalendarMonths(jan31, k).toISOString())
    expect(dates).toEqual(["2027-02-28T06:00:00.000Z", "2027-03-31T06:00:00.000Z", "2027-04-30T06:00:00.000Z", "2027-05-31T06:00:00.000Z"])
    // a leap year
    expect(addCalendarMonths(new Date("2028-01-31T08:00:00+02:00"), 1).toISOString()).toBe("2028-02-29T06:00:00.000Z")
  })

  it("reads the month on the South African calendar: 23:30 UTC on 30 Jan is 01:30 on 31 Jan in SAST, so one month on is 01:30 on 28 Feb", () => {
    expect(addCalendarMonths(new Date("2027-01-30T23:30:00Z"), 1).toISOString()).toBe("2027-02-27T23:30:00.000Z")
  })

  it("a year of weekly instalments from 10 Feb 2027 ends on 9 Feb 2028 (52 x 7 days, 2028 being a leap year)", () => {
    const last = generateSchedule(input({ terms: { frequency: "WEEKLY", instalments: 52 } })).schedule.at(-1)!
    expect(last.dueDate.toISOString()).toBe("2028-02-09T10:00:00.000Z")
  })
})

describe("the monthly service fee", () => {
  it("is charged once per month of the term, on the first instalment on or after each month: 8 weeks is 2 months, 2 fees", () => {
    const g = generateSchedule(input({ monthlyServiceFeeCents: 6_900, terms: { frequency: "WEEKLY", instalments: 8 } }))
    expect(g.serviceFees).toBe(13_800)
    // month 1 ends 10 Mar, which is exactly week 4 (28 days); month 2 ends 10 Apr, after the last (8th) week, so the fee goes on the last instalment
    const fees = g.schedule.map((r) => r.feesDue)
    expect(fees.reduce((a, b) => a + b, 0)).toBe(13_800)
    expect(fees.filter((f) => f > 0)).toHaveLength(2)
    expect(fees[3]).toBe(6_900)
    expect(fees[7]).toBe(6_900)
  })

  it("monthly: one fee on every instalment, as the existing instalment loans do", () => {
    const g = generateSchedule(input({ monthlyServiceFeeCents: 6_900, terms: { instalments: 4 } }))
    expect(g.schedule.map((r) => r.feesDue)).toEqual([6_900, 6_900, 6_900, 6_900])
  })
})

describe("it reconciles to the cent, whatever the structure", () => {
  const frequencies: Frequency[] = ["WEEKLY", "FORTNIGHTLY", "MONTHLY"]
  const structures: RepaymentStructure[] = ["AMORTISING", "INTEREST_ONLY", "BULLET"]
  const graces: Array<[GraceKind, number]> = [["NONE", 0], ["PRINCIPAL_ONLY", 1], ["PRINCIPAL_ONLY", 3], ["FULL", 1], ["FULL", 2]]
  // a fixed sequence of principals and rates: no randomness, so a failure names its case
  const principals = [100_000, 123_457, 999_999, 5_000_000, 7_654_321]
  const rates = [0, 0.0125, 0.05, 0.1033]

  it("principal rows add up to the principal, rows add up to principal + interest + fees, the last balance is 0, dates rise", () => {
    let cases = 0
    for (const frequency of frequencies) for (const structure of structures) for (const [graceKind, graceInstalments] of graces) {
      if (structure !== "AMORTISING" && graceKind === "PRINCIPAL_ONLY") continue
      if (structure === "BULLET" && graceKind !== "NONE") continue
      for (const interestModel of ["FLAT", "REDUCING_BALANCE"] as const) for (const instalments of [graceInstalments + 1, 6, 13, 26]) {
        for (const [i, principalCents] of principals.entries()) {
          const interestRatePm = rates[i % rates.length]!
          const g = generateSchedule(input({ principalCents, interestRatePm, interestModel, monthlyServiceFeeCents: 6_900, terms: { frequency, structure, graceKind, graceInstalments, instalments } }))
          const label = JSON.stringify({ frequency, structure, graceKind, graceInstalments, instalments, interestModel, principalCents, interestRatePm })
          const s = g.schedule
          expect(s.reduce((a, r) => a + r.principalDue, 0), label).toBe(principalCents)
          expect(s.reduce((a, r) => a + r.interestDue, 0), label).toBe(g.totalInterest)
          expect(s.reduce((a, r) => a + r.feesDue, 0), label).toBe(g.serviceFees)
          expect(s.reduce((a, r) => a + r.totalDue, 0), label).toBe(principalCents + g.totalInterest + g.serviceFees)
          expect(s.at(-1)!.closingBalance, label).toBe(0)
          for (const [k, row] of s.entries()) {
            expect(row.totalDue, label).toBe(row.principalDue + row.interestDue + row.feesDue)
            expect(row.principalDue >= 0 && row.interestDue >= 0 && row.feesDue >= 0, label).toBe(true)
            expect(row.totalDue, label).toBeGreaterThan(0)
            if (k > 0) {
              expect(row.dueDate.getTime(), label).toBeGreaterThan(s[k - 1]!.dueDate.getTime())
              expect(row.openingBalance, label).toBe(s[k - 1]!.closingBalance)
            }
          }
          cases++
        }
      }
    }
    expect(cases).toBeGreaterThan(1_000)
  })
})

describe("existing monthly products: the engine and lib/loan-calculator.ts agree to the cent", () => {
  it.each([[600_000, 0.03, 6], [1_000_000, 0.0233, 12], [250_000, 0.05, 3], [5_000_000, 0.0175, 24]])("R%s at %s a month over %s instalments", (principalCents, interestRatePm, months) => {
    const legacy = calculateLoan({
      principal: principalCents, termDays: months * 30, interestRatePm, interestModel: "REDUCING_BALANCE", initiationFeeModel: "FLAT_PCT",
      initiationFeePct: 0, initiationFeeMax: 0, monthlyServiceFee: 6_900, productType: "PERSONAL",
    }, START)
    const g = generateSchedule(input({ principalCents, interestRatePm, monthlyServiceFeeCents: 6_900, terms: { instalments: months } }))
    expect(g.schedule.map((r) => [r.principalDue, r.interestDue, r.feesDue, r.totalDue, r.openingBalance, r.closingBalance]))
      .toEqual(legacy.schedule.map((r) => [r.principalDue, r.interestDue, r.feesDue, r.totalDue, r.openingBalance, r.closingBalance]))
    expect(g.totalInterest).toBe(legacy.totalInterest)
    expect(g.serviceFees).toBe(legacy.serviceFees)
    expect(g.schedule.map((r) => r.dueDate.toISOString().slice(0, 10))).toEqual(legacy.schedule.map((r) => r.dueDate.toISOString().slice(0, 10)))
  })
})

describe("inputs it refuses", () => {
  it.each([
    ["no instalments", { instalments: 0 }],
    ["a grace as long as the term", { graceKind: "FULL" as const, graceInstalments: 6 }],
    ["a grace kind without periods", { graceKind: "FULL" as const, graceInstalments: 0 }],
    ["periods without a grace kind", { graceKind: "NONE" as const, graceInstalments: 2 }],
    ["a fractional instalment count", { instalments: 2.5 }],
  ])("%s", (_label, terms) => {
    expect(() => generateSchedule(input({ terms }))).toThrow()
  })

  it("a principal that is not a positive whole number of cents", () => {
    expect(() => generateSchedule(input({ principalCents: 0 }))).toThrow()
    expect(() => generateSchedule(input({ principalCents: 100.5 }))).toThrow()
  })
})
