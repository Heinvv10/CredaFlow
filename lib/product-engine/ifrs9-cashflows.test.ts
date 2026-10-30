/**
 * IFRS 9 (lib/ifrs9) reads a loan's cash flows from its RepaymentSchedule rows: the interest accrued since the last due date,
 * and the interest and fees due and unpaid. These tests run the engine's schedules through those functions, so the exposure a
 * weekly, graced, interest-only or bullet loan reports is what its contract says.
 */
import { describe, expect, it } from "vitest"
import { sastCalendarDate } from "@/lib/date/sast"
import { accruedInterestCents, interestRaisedBetween, unpaidScheduleAmounts, type ScheduleRow } from "@/lib/ifrs9/ecl"
import { generateSchedule } from "./schedule"
import type { RepaymentTerms } from "./types"

const START = new Date("2027-02-10T12:00:00+02:00")
const startDay = sastCalendarDate(START)
const rows = (terms: Partial<RepaymentTerms> & { instalments: number }, over: { rate?: number; fee?: number } = {}): ScheduleRow[] =>
  generateSchedule({
    principalCents: 1_000_000, interestRatePm: over.rate ?? 0.02, interestModel: "REDUCING_BALANCE", monthlyServiceFeeCents: over.fee ?? 0, startDate: START,
    terms: { frequency: "MONTHLY", structure: "AMORTISING", graceKind: "NONE", graceInstalments: 0, ...terms },
  }).schedule.map((r) => ({ dueDate: sastCalendarDate(r.dueDate), interestDue: r.interestDue, feesDue: r.feesDue, principalDue: r.principalDue, totalDue: r.totalDue, totalPaid: 0 }))

describe("IFRS 9 reads the engine's schedules", () => {
  it("weekly: the interest accrued part-way through a week is that week's interest by the day", () => {
    const weekly = rows({ frequency: "WEEKLY", instalments: 8 }, { rate: 0.04 })
    // 17 Feb is week 1's due date; 20 Feb is 3 days into week 2 (due 24 Feb)
    expect(weekly[0]!.dueDate).toBe("2027-02-17")
    expect(accruedInterestCents(weekly, "2027-02-20", startDay)).toBe(Math.round((weekly[1]!.interestDue * 3) / 7))
    // on a due date the instalment is raised and nothing is accrued towards it
    expect(accruedInterestCents(weekly, "2027-02-17", startDay)).toBe(Math.round((weekly[1]!.interestDue * 0) / 7))
  })

  it("full grace: before the first payment the accrual runs over the whole grace plus the first period, deferred interest included", () => {
    const graced = rows({ graceKind: "FULL", graceInstalments: 2, instalments: 6 })
    // first payment 10 May (89 days after 10 Feb) carries 30 000 (its own 20 000 and 10 000 of the deferred 40 000)
    expect(graced).toHaveLength(4)
    expect(graced[0]).toMatchObject({ dueDate: "2027-05-10", interestDue: 30_000 })
    expect(accruedInterestCents(graced, "2027-04-10", startDay)).toBe(Math.round((30_000 * 59) / 89))
    expect(accruedInterestCents(graced, "2027-05-10", startDay)).toBe(Math.round((graced[1]!.interestDue * 0) / 31))
  })

  it("principal-only grace: the interest-only instalments are raised as they fall due", () => {
    const graced = rows({ graceKind: "PRINCIPAL_ONLY", graceInstalments: 2, instalments: 6 })
    expect(interestRaisedBetween(graced, "2027-03-01", "2027-04-30")).toBe(40_000)
    expect(unpaidScheduleAmounts(graced, "2027-04-30")).toEqual({ interestCents: 40_000, feesCents: 0 })
  })

  it("interest-only: interest is raised every month and the principal waits for the last row", () => {
    const io = rows({ structure: "INTEREST_ONLY", instalments: 6 }, { fee: 6_900 })
    expect(unpaidScheduleAmounts(io, "2027-05-31")).toEqual({ interestCents: 3 * 20_000, feesCents: 3 * 6_900 })
    expect(io.at(-1)!.principalDue).toBe(1_000_000)
  })

  it("bullet: nothing falls due before maturity, so nothing is raised; the interest accrues across the whole term", () => {
    const bullet = rows({ structure: "BULLET", instalments: 6 })
    expect(bullet).toHaveLength(1)
    expect(unpaidScheduleAmounts(bullet, "2027-07-31")).toEqual({ interestCents: 0, feesCents: 0 })
    // 10 Feb to 10 Aug is 181 days; at 10 May, 89 days in
    expect(accruedInterestCents(bullet, "2027-05-10", startDay)).toBe(Math.round((120_000 * 89) / 181))
    expect(unpaidScheduleAmounts(bullet, "2027-08-10")).toEqual({ interestCents: 120_000, feesCents: 0 })
  })

  it("every schedule's interest, raised over its whole life, is what the engine says it earns", () => {
    for (const terms of [{ frequency: "WEEKLY" as const, instalments: 13 }, { frequency: "FORTNIGHTLY" as const, instalments: 6, graceKind: "FULL" as const, graceInstalments: 1 }, { structure: "BULLET" as const, instalments: 3 }]) {
      const r = rows(terms)
      const last = r.at(-1)!.dueDate
      expect(interestRaisedBetween(r, startDay, last)).toBe(r.reduce((a, x) => a + x.interestDue, 0))
    }
  })
})
