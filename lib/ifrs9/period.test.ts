import { describe, expect, it } from "vitest"
import { isLastDayOfMonth, monthlyRunTarget, periodEndDate, resolveMonthlyPeriod } from "./period"

describe("isLastDayOfMonth", () => {
  it("is true on the last calendar day, including a leap day", () => {
    expect(isLastDayOfMonth("2026-10-31")).toBe(true)
    expect(isLastDayOfMonth("2026-11-30")).toBe(true)
    expect(isLastDayOfMonth("2026-02-28")).toBe(true)
    expect(isLastDayOfMonth("2028-02-28")).toBe(false)
    expect(isLastDayOfMonth("2028-02-29")).toBe(true)
    expect(isLastDayOfMonth("2026-10-30")).toBe(false)
    expect(isLastDayOfMonth("2026-12-31")).toBe(true)
  })
})

describe("periodEndDate", () => {
  it("is the last day of the month", () => {
    expect(periodEndDate("2026-02")).toBe("2026-02-28")
    expect(periodEndDate("2026-12")).toBe("2026-12-31")
  })
})

describe("resolveMonthlyPeriod", () => {
  it("is the current month by default", () => {
    expect(resolveMonthlyPeriod("2026-10-31")).toEqual({ ok: true, periodKey: "2026-10" })
    expect(resolveMonthlyPeriod("2026-10-12", "2026-10")).toEqual({ ok: true, periodKey: "2026-10" })
  })

  it("lets a missed month-end run be made up in the first five days of the next month", () => {
    expect(resolveMonthlyPeriod("2026-11-05", "2026-10")).toEqual({ ok: true, periodKey: "2026-10" })
    expect(resolveMonthlyPeriod("2027-01-02", "2026-12")).toEqual({ ok: true, periodKey: "2026-12" })
  })

  it("refuses an older month, a later month and a late make-up", () => {
    expect(resolveMonthlyPeriod("2026-11-06", "2026-10").ok).toBe(false)
    expect(resolveMonthlyPeriod("2026-11-03", "2026-09").ok).toBe(false)
    expect(resolveMonthlyPeriod("2026-10-12", "2026-11").ok).toBe(false)
    expect(resolveMonthlyPeriod("2026-10-12", "garbage").ok).toBe(false)
  })
})

describe("monthlyRunTarget", () => {
  it("is this month on its last day and last month for the first five days of the next", () => {
    expect(monthlyRunTarget("2026-10-31")).toBe("2026-10")
    expect(monthlyRunTarget("2026-11-01")).toBe("2026-10")
    expect(monthlyRunTarget("2026-11-05")).toBe("2026-10")
    expect(monthlyRunTarget("2027-01-03")).toBe("2026-12")
  })

  it("is nothing on any other day", () => {
    expect(monthlyRunTarget("2026-11-06")).toBeNull()
    expect(monthlyRunTarget("2026-10-30")).toBeNull()
    expect(monthlyRunTarget("2026-11-15")).toBeNull()
  })
})
