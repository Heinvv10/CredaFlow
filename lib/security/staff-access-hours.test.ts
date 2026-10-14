import { describe, expect, it } from "vitest"
import { isWithinAccessHours, parseStaffAccessHours, type StaffAccessHours } from "./staff-access-hours"

const closed = { mon: null, tue: null, wed: null, thu: null, fri: null, sat: null, sun: null }
const weekdays: StaffAccessHours = {
  ...closed,
  mon: { start: "08:00", end: "17:00" },
  tue: { start: "08:00", end: "17:00" },
  wed: { start: "08:00", end: "17:00" },
  thu: { start: "08:00", end: "17:00" },
  fri: { start: "08:00", end: "17:00" },
}

// 2026-10-12 is a Monday. SAST = UTC+2 all year, so 08:00 SAST is 06:00Z.
const at = (iso: string) => new Date(iso)

describe("isWithinAccessHours (SAST, fixed UTC+2)", () => {
  it("opens at the window start, inclusive", () => {
    expect(isWithinAccessHours(weekdays, at("2026-10-12T05:59:59.999Z"))).toBe(false)
    expect(isWithinAccessHours(weekdays, at("2026-10-12T06:00:00.000Z"))).toBe(true)
  })

  it("closes at the window end, exclusive", () => {
    expect(isWithinAccessHours(weekdays, at("2026-10-12T14:59:59.999Z"))).toBe(true)
    expect(isWithinAccessHours(weekdays, at("2026-10-12T15:00:00.000Z"))).toBe(false)
  })

  it("judges the SAST weekday, not the UTC one, across midnight", () => {
    // 23:30Z Sunday is 01:30 SAST Monday.
    const night: StaffAccessHours = { ...closed, mon: { start: "00:00", end: "02:00" } }
    expect(isWithinAccessHours(night, at("2026-10-11T23:30:00.000Z"))).toBe(true)
    // 21:59:59.999Z Sunday is still 23:59:59.999 SAST Sunday: closed.
    expect(isWithinAccessHours(night, at("2026-10-11T21:59:59.999Z"))).toBe(false)
    // 22:00Z Sunday is SAST Monday midnight exactly: open.
    expect(isWithinAccessHours(night, at("2026-10-11T22:00:00.000Z"))).toBe(true)
  })

  it("treats 24:00 as the end of the SAST day", () => {
    const lateFriday: StaffAccessHours = { ...closed, fri: { start: "18:00", end: "24:00" } }
    // 2026-10-16 is a Friday. 21:59:59.999Z = 23:59:59.999 SAST Friday.
    expect(isWithinAccessHours(lateFriday, at("2026-10-16T21:59:59.999Z"))).toBe(true)
    // One millisecond later it is Saturday 00:00 SAST, which is closed.
    expect(isWithinAccessHours(lateFriday, at("2026-10-16T22:00:00.000Z"))).toBe(false)
  })

  it("never shifts by an hour in what would be a DST month elsewhere", () => {
    // Late March and late October are DST change weeks in Europe; SAST has none.
    for (const iso of ["2026-03-30T06:00:00.000Z", "2026-10-26T06:00:00.000Z"]) {
      expect(isWithinAccessHours(weekdays, at(iso))).toBe(true)
      expect(isWithinAccessHours(weekdays, new Date(at(iso).getTime() - 1))).toBe(false)
    }
  })

  it("keeps a closed day closed all day", () => {
    // 2026-10-17 is a Saturday.
    expect(isWithinAccessHours(weekdays, at("2026-10-17T10:00:00.000Z"))).toBe(false)
  })
})

describe("parseStaffAccessHours", () => {
  it("accepts a full week with closed days", () => {
    const parsed = parseStaffAccessHours(weekdays)
    expect(parsed).toEqual({ ok: true, hours: weekdays })
  })

  it("refuses a missing weekday", () => {
    const { sun: _sun, ...partial } = weekdays
    expect(parseStaffAccessHours(partial).ok).toBe(false)
  })

  it("refuses a window that ends before it starts or wraps midnight", () => {
    expect(parseStaffAccessHours({ ...weekdays, mon: { start: "17:00", end: "08:00" } }).ok).toBe(false)
    expect(parseStaffAccessHours({ ...weekdays, mon: { start: "08:00", end: "08:00" } }).ok).toBe(false)
  })

  it("refuses malformed times", () => {
    for (const bad of ["8:00", "24:01", "25:00", "12:60", "noon", ""]) {
      expect(parseStaffAccessHours({ ...weekdays, mon: { start: bad, end: "23:00" } }).ok, bad).toBe(false)
    }
    expect(parseStaffAccessHours({ ...weekdays, mon: { start: "24:00", end: "24:00" } }).ok).toBe(false)
  })

  it("refuses unknown keys so a typo cannot silently close a day", () => {
    expect(parseStaffAccessHours({ ...weekdays, monday: { start: "08:00", end: "17:00" } }).ok).toBe(false)
  })

  it("refuses a week with no open day, which would lock every non-Super-Admin out", () => {
    expect(parseStaffAccessHours(closed).ok).toBe(false)
  })
})
