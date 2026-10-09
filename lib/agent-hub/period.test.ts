import { describe, it, expect } from "vitest"
import { parsePeriod } from "./period"

describe("parsePeriod", () => {
  // SAST is UTC+2, so a SAST day starts at 22:00 UTC the previous day.
  // Getting this wrong misfiles every event near a month boundary.
  it("treats a from-date as SAST midnight, not UTC midnight", () => {
    const { fromUtc } = parsePeriod("2026-08-01", "2026-08-31")
    expect(fromUtc.toISOString()).toBe("2026-07-31T22:00:00.000Z")
  })

  it("makes the to-date exclusive at the END of that SAST day", () => {
    const { toUtc } = parsePeriod("2026-08-01", "2026-08-31")
    expect(toUtc.toISOString()).toBe("2026-08-31T22:00:00.000Z")
  })

  it("defaults to the current SAST month when given nothing", () => {
    const { label } = parsePeriod(null, null)
    expect(label).toMatch(/^\d{4}-\d{2}-01 to \d{4}-\d{2}-\d{2}$/)
  })

  it("rejects a reversed range rather than returning no rows", () => {
    expect(() => parsePeriod("2026-08-31", "2026-08-01")).toThrow(/before/i)
  })

  it("rejects a malformed date rather than silently defaulting", () => {
    expect(() => parsePeriod("not-a-date", "2026-08-31")).toThrow(/YYYY-MM-DD/)
  })

  it("rejects February 30 (invalid calendar date)", () => {
    expect(() => parsePeriod("2026-02-30", "2026-08-31")).toThrow(/YYYY-MM-DD/)
  })

  it("rejects April 31 (invalid calendar date)", () => {
    expect(() => parsePeriod("2026-04-31", "2026-08-31")).toThrow(/YYYY-MM-DD/)
  })

  it("rejects February 29 in a non-leap year (2026)", () => {
    expect(() => parsePeriod("2026-02-29", "2026-08-31")).toThrow(/YYYY-MM-DD/)
  })

  it("accepts February 29 in a leap year (2028)", () => {
    const { fromUtc } = parsePeriod("2028-02-29", "2028-08-31")
    expect(fromUtc.toISOString()).toBe("2028-02-28T22:00:00.000Z")
  })

  // Next.js hands back "" (not undefined) for a present-but-empty query param
  // (e.g. a date-filter form field the user cleared before submitting), and
  // the `from || default` fallback used to treat that the same as "absent" —
  // silently reporting the current-month default instead of the period the
  // URL looked like it was asking for. That is a money-reporting bug, so an
  // empty string is rejected explicitly rather than aliased to "absent".
  it("rejects an empty string from-param instead of silently defaulting", () => {
    expect(() => parsePeriod("", "2026-08-31")).toThrow(/empty/i)
  })

  it("rejects an empty string to-param instead of silently defaulting", () => {
    expect(() => parsePeriod("2026-08-01", "")).toThrow(/empty/i)
  })

  it("still defaults to the current SAST month when both params are truly absent (undefined)", () => {
    expect(() => parsePeriod(undefined, undefined)).not.toThrow()
  })
})
