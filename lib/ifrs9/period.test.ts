import { describe, expect, it } from "vitest"
import { isLastDayOfMonth, monthlyRunTarget, periodEndDate } from "./period"

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
