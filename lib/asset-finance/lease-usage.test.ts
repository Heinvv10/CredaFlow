import { describe, expect, it } from "vitest"
import { excessUsage, projectedExcessUsage } from "./lease-usage"

describe("excessUsage (C6)", () => {
  it("(final − start − allowance × years) × rate", () => {
    // 36 months, 1 500 h a year: 4 500 h allowed; 5 120 − 400 = 4 720 used → 220 h over at R350.
    expect(excessUsage({ startReading: 400, finalReading: 5_120, allowancePerYear: 1_500, termMonths: 36, excessRateCents: 35_000 }))
      .toEqual({ usedUnits: 4_720, allowedTwelfths: 54_000, excessTwelfths: 2_640, excessCents: 7_700_000 })
  })
  it("never below zero", () => {
    expect(excessUsage({ startReading: 0, finalReading: 10, allowancePerYear: 1_500, termMonths: 36, excessRateCents: 35_000 }).excessCents).toBe(0)
  })
  it("a part year is allowed pro rata, the charge rounded half-up to the cent", () => {
    // 26 months of 30 000 km: 65 000 km allowed; 65 001 used → 1 km over at R2.55 → R2.55
    expect(excessUsage({ startReading: 0, finalReading: 65_001, allowancePerYear: 30_000, termMonths: 26, excessRateCents: 255 }).excessCents).toBe(255)
    // 25 months of 1 000 h: 2 083.333 h allowed; 2 084 used → 0.6667 h at 101c = 67.33 → 67c
    expect(excessUsage({ startReading: 0, finalReading: 2_084, allowancePerYear: 1_000, termMonths: 25, excessRateCents: 101 }).excessCents).toBe(67)
  })
  it("exactly at the allowance: nothing; a half-cent is rounded up", () => {
    // 12 months of 1 200 h: 1 200 used is exactly the allowance.
    expect(excessUsage({ startReading: 50, finalReading: 1_250, allowancePerYear: 1_200, termMonths: 12, excessRateCents: 35_000 }))
      .toEqual({ usedUnits: 1_200, allowedTwelfths: 14_400, excessTwelfths: 0, excessCents: 0 })
    // 1 month of 11 h a year allows 11/12 h; 1 h used → 1/12 h over at 6c = 0.5c → 1c (half-up, not half-even).
    expect(excessUsage({ startReading: 0, finalReading: 1, allowancePerYear: 11, termMonths: 1, excessRateCents: 6 }).excessCents).toBe(1)
    // 3/12 h over at 6c = 1.5c → 2c.
    expect(excessUsage({ startReading: 0, finalReading: 1, allowancePerYear: 9, termMonths: 1, excessRateCents: 6 }).excessCents).toBe(2)
  })
  it("refuses a final reading below the start", () => {
    expect(() => excessUsage({ startReading: 10, finalReading: 9, allowancePerYear: 1, termMonths: 12, excessRateCents: 1 })).toThrow(RangeError)
  })
})

describe("projectedExcessUsage", () => {
  it("extrapolates the usage rate so far to the end of the term", () => {
    // Half-way through a 36-month term with 2 600 h used: 5 200 projected, 700 over at R350.
    const p = projectedExcessUsage({
      startReading: 0, startDate: "2027-01-01", latestReading: 2_600, latestDate: "2028-07-02", endDate: "2030-01-01",
      allowancePerYear: 1_500, termMonths: 36, excessRateCents: 35_000,
    })
    expect(p.projectedFinalReading).toBe(5_200)
    expect(p.excessCents).toBe(24_500_000)
  })
  it("no reading after the start: no projection", () => {
    expect(projectedExcessUsage({
      startReading: 0, startDate: "2027-01-01", latestReading: 0, latestDate: "2027-01-01", endDate: "2030-01-01",
      allowancePerYear: 1_500, termMonths: 36, excessRateCents: 35_000,
    }).excessCents).toBe(0)
  })
})
