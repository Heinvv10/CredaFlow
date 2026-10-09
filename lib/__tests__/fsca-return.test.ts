import { describe, it, expect } from "vitest"
import {
  quarterBounds,
  listSelectableQuarters,
  defaultQuarter,
  parseQuarterParam,
} from "../fsca-return"

describe("quarterBounds", () => {
  // SAST-midnight, not UTC-midnight: a policy incepted at 00:30 on 1 January
  // in Johannesburg belongs to Q1, and UTC bounds put it in the prior Q4.
  // Full boundary coverage lives in lib/compliance/quarters.test.ts.
  it("returns end-exclusive SAST bounds for Q1", () => {
    const { start, end } = quarterBounds("2026-Q1")
    expect(start.toISOString()).toBe("2025-12-31T22:00:00.000Z")
    expect(end.toISOString()).toBe("2026-03-31T22:00:00.000Z")
  })

  it("returns end-exclusive SAST bounds for Q4", () => {
    const { start, end } = quarterBounds("2026-Q4")
    expect(start.toISOString()).toBe("2026-09-30T22:00:00.000Z")
    expect(end.toISOString()).toBe("2026-12-31T22:00:00.000Z")
  })

  it("throws on malformed input", () => {
    expect(() => quarterBounds("2026-Q5")).toThrow("Invalid quarter string")
    expect(() => quarterBounds("2026")).toThrow("Invalid quarter string")
    expect(() => quarterBounds("foo")).toThrow("Invalid quarter string")
  })
})

describe("listSelectableQuarters", () => {
  it("returns 5 quarters in descending order ending at the current quarter", () => {
    const result = listSelectableQuarters(new Date("2026-05-19T00:00:00Z"))
    expect(result).toEqual([
      "2026-Q2",
      "2026-Q1",
      "2025-Q4",
      "2025-Q3",
      "2025-Q2",
    ])
  })

  it("handles year boundaries", () => {
    const result = listSelectableQuarters(new Date("2026-02-15T00:00:00Z"))
    expect(result).toEqual([
      "2026-Q1",
      "2025-Q4",
      "2025-Q3",
      "2025-Q2",
      "2025-Q1",
    ])
  })
})

describe("defaultQuarter", () => {
  it("returns the previous quarter when current is Q2", () => {
    expect(defaultQuarter(new Date("2026-05-19T00:00:00Z"))).toBe("2026-Q1")
  })

  it("crosses year boundary in Q1", () => {
    expect(defaultQuarter(new Date("2026-02-01T00:00:00Z"))).toBe("2025-Q4")
  })
})

describe("parseQuarterParam", () => {
  const now = new Date("2026-05-19T00:00:00Z")

  it("returns valid in-range quarter unchanged", () => {
    expect(parseQuarterParam("2026-Q1", now)).toBe("2026-Q1")
    expect(parseQuarterParam("2025-Q2", now)).toBe("2025-Q2")
  })

  it("falls back to defaultQuarter for missing param", () => {
    expect(parseQuarterParam(undefined, now)).toBe("2026-Q1")
  })

  it("falls back to defaultQuarter for malformed input", () => {
    expect(parseQuarterParam("foo", now)).toBe("2026-Q1")
    expect(parseQuarterParam("2026-Q5", now)).toBe("2026-Q1")
    expect(parseQuarterParam("", now)).toBe("2026-Q1")
  })

  it("falls back to defaultQuarter for out-of-range quarter", () => {
    expect(parseQuarterParam("2020-Q1", now)).toBe("2026-Q1")
    expect(parseQuarterParam("2030-Q1", now)).toBe("2026-Q1")
  })
})
