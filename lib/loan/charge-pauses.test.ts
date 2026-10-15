import { describe, expect, it } from "vitest"
import { withoutPausedDays } from "./charge-pauses"
import { sastCalendarDay } from "@/lib/loan/settlement"

const d = (ymd: string) => new Date(`${ymd}T12:00:00+02:00`)
const day = (ymd: string) => sastCalendarDay(d(ymd))
const always = () => true

describe("withoutPausedDays", () => {
  it("returns the predicate itself when there are no pauses", () => {
    expect(withoutPausedDays(always, undefined)).toBe(always)
    expect(withoutPausedDays(always, [])).toBe(always)
  })

  it("pauses both end days inclusive and nothing outside them", () => {
    const chargeable = withoutPausedDays(always, [{ from: d("2026-03-10"), until: d("2026-03-12") }])
    expect(chargeable(day("2026-03-09"))).toBe(true)
    expect(chargeable(day("2026-03-10"))).toBe(false)
    expect(chargeable(day("2026-03-11"))).toBe(false)
    expect(chargeable(day("2026-03-12"))).toBe(false)
    expect(chargeable(day("2026-03-13"))).toBe(true)
  })

  it("compares SAST calendar days, not instants", () => {
    // 23:30 SAST on the 10th is 21:30 UTC the same day; 00:30 SAST on the 12th is 22:30 UTC on the 11th.
    const chargeable = withoutPausedDays(always, [
      { from: new Date("2026-03-10T21:30:00Z"), until: new Date("2026-03-11T22:30:00Z") },
    ])
    expect(chargeable(day("2026-03-10"))).toBe(false)
    expect(chargeable(day("2026-03-12"))).toBe(false)
    expect(chargeable(day("2026-03-13"))).toBe(true)
  })

  it("keeps the base predicate's own limits and supports several pauses", () => {
    const base = (n: number) => n >= day("2026-03-05")
    const chargeable = withoutPausedDays(base, [
      { from: d("2026-03-10"), until: d("2026-03-10") },
      { from: d("2026-03-20"), until: d("2026-03-21") },
    ])
    expect(chargeable(day("2026-03-04"))).toBe(false)
    expect(chargeable(day("2026-03-10"))).toBe(false)
    expect(chargeable(day("2026-03-11"))).toBe(true)
    expect(chargeable(day("2026-03-21"))).toBe(false)
    expect(chargeable(day("2026-03-22"))).toBe(true)
  })

  it("refuses a pause that ends before it starts or has an invalid date", () => {
    expect(() => withoutPausedDays(always, [{ from: d("2026-03-12"), until: d("2026-03-10") }])).toThrow(RangeError)
    expect(() => withoutPausedDays(always, [{ from: new Date(Number.NaN), until: d("2026-03-10") }])).toThrow()
  })
})
