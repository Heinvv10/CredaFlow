import { describe, expect, it } from "vitest"
import { addMonthsClamped, fromDayNumber, toDayNumber } from "./dates"
import { dealStartDate } from "./deal-structure"
import { monthEndClamps, plannedStartFor } from "./first-due.test-helpers"

const daysOf = (year: number) => {
  const first = toDayNumber(`${year}-01-01`)
  const next = toDayNumber(`${year + 1}-01-01`)
  return Array.from({ length: next - first }, (_, i) => fromDayNumber(first + i))
}
// How the fixtures set a deal up: the first instalment a month on from today
const firstDueOf = (today: string) => addMonthsClamped(today, 1)

describe("plannedStartFor: a start the signing prepare step accepts, from the first instalment the fixtures use", () => {
  it("is the deal's own start (a month before the first instalment) on a day that round-trips", () => {
    expect(plannedStartFor("2026-11-15", "2026-10-15")).toBe("2026-10-15")
    expect(plannedStartFor("2026-11-29", "2026-10-29")).toBe("2026-10-29")
  })

  it("is today on a month-end day, where a month before the clamped first instalment is a day gone: 31 Oct -> first 30 Nov -> start 30 Oct is past", () => {
    expect(dealStartDate(firstDueOf("2026-10-31"))).toBe("2026-10-30")
    expect(plannedStartFor(firstDueOf("2026-10-31"), "2026-10-31")).toBe("2026-10-31")
    expect(plannedStartFor(firstDueOf("2027-01-30"), "2027-01-30")).toBe("2027-01-30")
    expect(plannedStartFor(firstDueOf("2028-01-31"), "2028-01-31")).toBe("2028-01-31") // a leap year: first instalment 29 Feb
  })

  it("is never in the past, never more than a day after today, and never later than the term was approved from, on every day of 2026, 2027 and 2028", () => {
    for (const today of [...daysOf(2026), ...daysOf(2027), ...daysOf(2028)]) {
      const first = firstDueOf(today)
      const start = plannedStartFor(first, today)
      expect(start >= today, today).toBe(true)
      expect(toDayNumber(start) - toDayNumber(today), today).toBeLessThanOrEqual(0)
      // not after the structure's own start unless that start is itself today or later: the prepared term never exceeds the approved one
      expect(start <= (dealStartDate(first) < today ? today : dealStartDate(first)), today).toBe(true)
    }
  })

  it("is what the old pattern was not: dealStartDate(addMonthsClamped(today, 1)) is in the past on the 29th to the 31st", () => {
    const old = (today: string) => dealStartDate(firstDueOf(today))
    const pastDays = daysOf(2026).filter((today) => old(today) < today)
    expect(pastDays).toContain("2026-10-31")
    expect(pastDays.length).toBeGreaterThanOrEqual(5)
    for (const today of ["2026-10-31", "2027-01-29", "2027-01-30", "2027-01-31", "2027-03-31"]) {
      expect(old(today) < today, today).toBe(true)
      expect(plannedStartFor(firstDueOf(today), today) >= today, today).toBe(true)
    }
  })
})

describe("monthEndClamps: the days a lease moved back whole months ends a day early", () => {
  it("is true on 31 Oct, 29 to 31 Jan, 31 Mar, and false on a day that round-trips", () => {
    for (const today of ["2026-10-31", "2027-01-29", "2027-01-30", "2027-01-31", "2027-03-31", "2028-01-30"]) expect(monthEndClamps(today), today).toBe(true)
    for (const today of ["2026-10-30", "2026-10-15", "2027-02-28", "2026-11-01", "2027-01-28"]) expect(monthEndClamps(today), today).toBe(false)
  })

  it("is exactly the days on which the old first instalment put the deal's start in the past", () => {
    for (const today of [...daysOf(2026), ...daysOf(2027), ...daysOf(2028)]) {
      expect(monthEndClamps(today), today).toBe(dealStartDate(firstDueOf(today)) < today)
    }
  })
})
