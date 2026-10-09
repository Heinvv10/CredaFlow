import { describe, it, expect } from "vitest"
import {
  quarterBounds,
  currentQuarter,
  shiftQuarter,
  listSelectableQuarters,
  defaultQuarter,
  parseQuarterParam,
  isQuarterOpen,
  sastQuarterBounds,
  sastMonthBounds,
  quarterLabel,
} from "./quarters"

describe("quarterBounds", () => {
  it("returns SAST-midnight bounds for Q1", () => {
    const { start, end } = quarterBounds("2026-Q1")
    expect(start.toISOString()).toBe("2025-12-31T22:00:00.000Z")
    expect(end.toISOString()).toBe("2026-03-31T22:00:00.000Z")
  })

  it("returns SAST-midnight bounds for Q4 and crosses the year", () => {
    const { start, end } = quarterBounds("2026-Q4")
    expect(start.toISOString()).toBe("2026-09-30T22:00:00.000Z")
    expect(end.toISOString()).toBe("2026-12-31T22:00:00.000Z")
  })

  it("is end-exclusive: a quarter's end is the next quarter's start", () => {
    expect(quarterBounds("2026-Q2").end.toISOString())
      .toBe(quarterBounds("2026-Q3").start.toISOString())
  })

  it("throws on malformed input", () => {
    expect(() => quarterBounds("2026-Q5")).toThrow("Invalid quarter string")
    expect(() => quarterBounds("2026-Q0")).toThrow("Invalid quarter string")
    expect(() => quarterBounds("2026")).toThrow("Invalid quarter string")
    expect(() => quarterBounds("foo")).toThrow("Invalid quarter string")
  })
})

describe("quarter edges in SAST", () => {
  // The two-hour window that UTC bounds got wrong. 00:30 SAST on 1 October is
  // 22:30 UTC on 30 September; the business calls it Q4 and so must we.
  const justAfterQ4Opens = new Date("2026-09-30T22:30:00.000Z")
  const justBeforeQ4Opens = new Date("2026-09-30T21:30:00.000Z")

  it("places 00:30 SAST on 1 October in Q4", () => {
    expect(currentQuarter(justAfterQ4Opens)).toBe("2026-Q4")
    const { start, end } = quarterBounds("2026-Q4")
    expect(justAfterQ4Opens >= start).toBe(true)
    expect(justAfterQ4Opens < end).toBe(true)
  })

  it("places 23:30 SAST on 30 September in Q3", () => {
    expect(currentQuarter(justBeforeQ4Opens)).toBe("2026-Q3")
    expect(justBeforeQ4Opens < quarterBounds("2026-Q4").start).toBe(true)
  })

  it("assigns every instant to exactly one quarter across the boundary", () => {
    const q3 = quarterBounds("2026-Q3")
    const q4 = quarterBounds("2026-Q4")
    for (const iso of [
      "2026-09-30T21:59:59.999Z",
      "2026-09-30T22:00:00.000Z",
      "2026-09-30T22:00:00.001Z",
    ]) {
      const t = new Date(iso)
      const inQ3 = t >= q3.start && t < q3.end
      const inQ4 = t >= q4.start && t < q4.end
      expect(Number(inQ3) + Number(inQ4)).toBe(1)
    }
  })
})

describe("currentQuarter", () => {
  it("maps each month to its quarter", () => {
    expect(currentQuarter(new Date("2026-02-15T10:00:00Z"))).toBe("2026-Q1")
    expect(currentQuarter(new Date("2026-05-15T10:00:00Z"))).toBe("2026-Q2")
    expect(currentQuarter(new Date("2026-08-15T10:00:00Z"))).toBe("2026-Q3")
    expect(currentQuarter(new Date("2026-11-15T10:00:00Z"))).toBe("2026-Q4")
  })

  it("uses the SAST calendar day at the new-year boundary", () => {
    // 00:30 SAST on 1 January 2027 is 22:30 UTC on 31 December 2026.
    expect(currentQuarter(new Date("2026-12-31T22:30:00Z"))).toBe("2027-Q1")
    expect(currentQuarter(new Date("2026-12-31T21:30:00Z"))).toBe("2026-Q4")
  })
})

describe("shiftQuarter", () => {
  it("moves forward and backward across year boundaries", () => {
    expect(shiftQuarter("2026-Q1", -1)).toBe("2025-Q4")
    expect(shiftQuarter("2026-Q4", 1)).toBe("2027-Q1")
    expect(shiftQuarter("2026-Q3", -6)).toBe("2025-Q1")
    expect(shiftQuarter("2026-Q1", 0)).toBe("2026-Q1")
  })

  it("round-trips", () => {
    expect(shiftQuarter(shiftQuarter("2026-Q2", -5), 5)).toBe("2026-Q2")
  })
})

describe("listSelectableQuarters", () => {
  it("returns 5 quarters newest first, starting at the current one", () => {
    expect(listSelectableQuarters(new Date("2026-05-19T00:00:00Z"))).toEqual([
      "2026-Q2", "2026-Q1", "2025-Q4", "2025-Q3", "2025-Q2",
    ])
  })

  it("handles year boundaries", () => {
    expect(listSelectableQuarters(new Date("2026-02-15T00:00:00Z"))).toEqual([
      "2026-Q1", "2025-Q4", "2025-Q3", "2025-Q2", "2025-Q1",
    ])
  })
})

describe("defaultQuarter", () => {
  it("returns the quarter that has just closed, never the open one", () => {
    expect(defaultQuarter(new Date("2026-05-19T00:00:00Z"))).toBe("2026-Q1")
    expect(defaultQuarter(new Date("2026-02-01T00:00:00Z"))).toBe("2025-Q4")
  })

  it("is always selectable", () => {
    const now = new Date("2026-08-16T10:00:00Z")
    expect(listSelectableQuarters(now)).toContain(defaultQuarter(now))
  })
})

describe("parseQuarterParam", () => {
  const now = new Date("2026-05-19T00:00:00Z")

  it("returns a valid in-range quarter unchanged", () => {
    expect(parseQuarterParam("2026-Q1", now)).toBe("2026-Q1")
    expect(parseQuarterParam("2025-Q2", now)).toBe("2025-Q2")
    expect(parseQuarterParam("2026-Q2", now)).toBe("2026-Q2")
  })

  it("falls back to the default for missing, malformed or out-of-range input", () => {
    for (const raw of [undefined, "", "foo", "2026-Q5", "2020-Q1", "2030-Q1"]) {
      expect(parseQuarterParam(raw, now)).toBe("2026-Q1")
    }
  })
})

describe("isQuarterOpen", () => {
  const now = new Date("2026-08-16T10:00:00Z") // 2026-Q3

  it("is true for the quarter in progress", () => {
    expect(isQuarterOpen("2026-Q3", now)).toBe(true)
  })

  it("is false for a closed quarter", () => {
    expect(isQuarterOpen("2026-Q2", now)).toBe(false)
  })

  it("closes exactly at the SAST quarter end, not before", () => {
    const lastInstant = new Date(quarterBounds("2026-Q3").end.getTime() - 1)
    expect(isQuarterOpen("2026-Q3", lastInstant)).toBe(true)
    expect(isQuarterOpen("2026-Q3", quarterBounds("2026-Q3").end)).toBe(false)
  })
})

describe("sastQuarterBounds", () => {
  it("returns the bounds of the quarter containing the instant", () => {
    const { start, endExclusive } = sastQuarterBounds(new Date("2026-08-16T10:00:00Z"))
    expect(start.toISOString()).toBe("2026-06-30T22:00:00.000Z")
    expect(endExclusive.toISOString()).toBe("2026-09-30T22:00:00.000Z")
  })

  it("agrees with quarterBounds(currentQuarter(now))", () => {
    const now = new Date("2026-11-02T05:00:00Z")
    const viaInstant = sastQuarterBounds(now)
    const viaString = quarterBounds(currentQuarter(now))
    expect(viaInstant.start.toISOString()).toBe(viaString.start.toISOString())
    expect(viaInstant.endExclusive.toISOString()).toBe(viaString.end.toISOString())
  })
})

describe("quarterLabel", () => {
  it("formats for display", () => {
    expect(quarterLabel("2026-Q3")).toBe("Q3 2026")
  })

  it("throws on malformed input", () => {
    expect(() => quarterLabel("nope")).toThrow("Invalid quarter string")
  })
})

describe("sastMonthBounds", () => {
  const AUG = new Date("2026-08-16T10:00:00Z")

  it("returns SAST-midnight bounds for the containing month", () => {
    const { start, end } = sastMonthBounds(AUG)
    expect(start.toISOString()).toBe("2026-07-31T22:00:00.000Z")
    expect(end.toISOString()).toBe("2026-08-31T22:00:00.000Z")
  })

  it("includes a receipt on the last day of the month", () => {
    // The defect this replaces: `new Date(y, m+1, 0)` is the last DAY at
    // 00:00, and filtering `lte` it dropped the whole final day.
    const { start, end } = sastMonthBounds(AUG)
    const lastDayReceipt = new Date("2026-08-31T09:00:00Z") // 11:00 SAST, 31 Aug
    expect(lastDayReceipt >= start && lastDayReceipt < end).toBe(true)
  })

  it("excludes the first instant of the next month", () => {
    const { end } = sastMonthBounds(AUG)
    const nextMonth = new Date("2026-08-31T22:00:00.000Z") // 00:00 SAST, 1 Sep
    expect(nextMonth < end).toBe(false)
    expect(sastMonthBounds(nextMonth).start.toISOString()).toBe("2026-08-31T22:00:00.000Z")
  })

  it("walks backwards across a year boundary", () => {
    const jan = new Date("2026-01-15T10:00:00Z")
    expect(sastMonthBounds(jan, -1).start.toISOString()).toBe("2025-11-30T22:00:00.000Z")
    expect(sastMonthBounds(jan, -1).end.toISOString()).toBe("2025-12-31T22:00:00.000Z")
  })

  it("tiles consecutive months with no gap and no overlap", () => {
    for (let i = -6; i < 0; i++) {
      expect(sastMonthBounds(AUG, i).end.toISOString())
        .toBe(sastMonthBounds(AUG, i + 1).start.toISOString())
    }
  })

  it("handles February and 31-day months", () => {
    const feb = new Date("2026-02-10T10:00:00Z")
    expect(sastMonthBounds(feb).end.toISOString()).toBe("2026-02-28T22:00:00.000Z")
  })
})
