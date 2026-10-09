import { describe, expect, it } from "vitest"
import {
  addSouthAfricanBusinessDays,
  isSouthAfricanBusinessDate,
  sastCalendarDaysBetween,
  quotationIsBindingAt,
  quotationValidUntilDate,
} from "./sa-business-days"

describe("South African quotation business-day window", () => {
  it("keeps a Friday quotation binding through the following Friday", () => {
    const presented = new Date("2026-07-24T10:00:00.000Z")
    expect(quotationValidUntilDate(presented)).toBe("2026-07-31")
    expect(quotationIsBindingAt(
      presented,
      new Date("2026-07-31T19:00:00.000Z"),
    )).toBe(true)
    expect(quotationIsBindingAt(
      presented,
      new Date("2026-07-31T22:00:00.000Z"),
    )).toBe(false)
  })

  it("excludes fixed, Easter and Sunday-observed public holidays", () => {
    expect(isSouthAfricanBusinessDate("2026-04-03")).toBe(false)
    expect(isSouthAfricanBusinessDate("2026-04-06")).toBe(false)
    expect(addSouthAfricanBusinessDays("2026-04-02", 5)).toBe("2026-04-13")
    expect(isSouthAfricanBusinessDate("2026-08-10")).toBe(false)
  })

  it("includes the proclaimed 2024 election public holiday", () => {
    const presented = new Date("2024-05-22T08:00:00.000Z")
    expect(quotationValidUntilDate(presented)).toBe("2024-05-30")
  })

  it("never treats an instant before presentation as binding", () => {
    const presented = new Date("2026-07-24T10:00:00.000Z")
    expect(quotationIsBindingAt(
      presented,
      new Date("2026-07-24T09:59:59.999Z"),
    )).toBe(false)
  })
})

// The payout anchor. A credit agreement's schedule is established when the
// agreement is generated, but the consumer's term must run from the day the
// money actually reaches them. This is the shift between the two, counted in
// whole SAST calendar days so that a payout later on the SAME day moves
// nothing -- the overwhelmingly common case must stay byte-identical.
describe("sastCalendarDaysBetween", () => {
  it("is zero for any two instants on the same SAST day", () => {
    // 02:00 SAST and 23:59 SAST on 2026-05-10 (UTC+2, no daylight saving).
    expect(sastCalendarDaysBetween(
      new Date("2026-05-10T00:00:00.000Z"),
      new Date("2026-05-10T21:59:59.999Z"),
    )).toBe(0)
  })

  it("counts a payout the next SAST day as exactly one day", () => {
    // 23:59 SAST on the 10th to 00:01 SAST on the 11th is two minutes of wall
    // clock but a whole day of credit — the consumer loses a day otherwise.
    expect(sastCalendarDaysBetween(
      new Date("2026-05-10T21:59:00.000Z"),
      new Date("2026-05-10T22:01:00.000Z"),
    )).toBe(1)
  })

  it("counts multi-day gaps", () => {
    expect(sastCalendarDaysBetween(
      new Date("2026-05-10T09:00:00.000Z"),
      new Date("2026-05-13T09:00:00.000Z"),
    )).toBe(3)
  })

  it("is negative when the payout precedes the schedule start", () => {
    // Not expected in practice — the disburse route refuses it separately — but
    // the arithmetic must not silently read backwards as forwards.
    expect(sastCalendarDaysBetween(
      new Date("2026-05-11T09:00:00.000Z"),
      new Date("2026-05-10T09:00:00.000Z"),
    )).toBe(-1)
  })

  it("refuses an unusable instant rather than guessing a shift", () => {
    expect(() => sastCalendarDaysBetween(
      new Date("nonsense"),
      new Date("2026-05-10T09:00:00.000Z"),
    )).toThrow(RangeError)
  })
})
