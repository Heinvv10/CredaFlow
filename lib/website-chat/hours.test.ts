import { describe, expect, it } from "vitest"
import { formatBusinessHours, isBusinessOpen } from "./hours"

// SAST = UTC+2, no DST. 2026-09-30 is a Wednesday.
const sast = (iso: string) => new Date(`${iso}+02:00`)

describe("isBusinessOpen defaults", () => {
  it("is open Wed 10:00 SAST", () => {
    expect(isBusinessOpen(null, sast("2026-09-30T10:00:00"))).toBe(true)
  })
  it("is open at 08:00 exactly and closed at 07:59", () => {
    expect(isBusinessOpen(null, sast("2026-09-30T08:00:00"))).toBe(true)
    expect(isBusinessOpen(null, sast("2026-09-30T07:59:00"))).toBe(false)
  })
  it("is open at 16:59 and closed at 17:00 exactly", () => {
    expect(isBusinessOpen(null, sast("2026-09-30T16:59:00"))).toBe(true)
    expect(isBusinessOpen(null, sast("2026-09-30T17:00:00"))).toBe(false)
  })
  it("is closed Saturday and Sunday", () => {
    expect(isBusinessOpen(null, sast("2026-10-03T10:00:00"))).toBe(false)
    expect(isBusinessOpen(null, sast("2026-10-04T10:00:00"))).toBe(false)
  })
  it("evaluates in SAST, not UTC", () => {
    // 2026-09-30T23:30Z is Thu 01:30 SAST (closed); 2026-09-30T06:30Z is Wed 08:30 SAST (open)
    expect(isBusinessOpen(null, new Date("2026-09-30T23:30:00Z"))).toBe(false)
    expect(isBusinessOpen(null, new Date("2026-09-30T06:30:00Z"))).toBe(true)
    // Fri 22:30Z is Sat 00:30 SAST: closed although Friday in UTC
    expect(isBusinessOpen(null, new Date("2026-10-02T22:30:00Z"))).toBe(false)
  })
})

describe("isBusinessOpen custom settings", () => {
  const custom = {
    tz: "Africa/Johannesburg",
    days: { sat: { open: "09:00", close: "12:00" }, mon: null },
  }
  it("opens Saturday 10:00 and closes Monday 10:00", () => {
    expect(isBusinessOpen(custom, sast("2026-10-03T10:00:00"))).toBe(true)
    expect(isBusinessOpen(custom, sast("2026-10-05T10:00:00"))).toBe(false)
  })
  it("treats an absent day key as closed", () => {
    expect(isBusinessOpen(custom, sast("2026-09-30T10:00:00"))).toBe(false)
  })
  it("evaluates in the settings tz", () => {
    const utc = { tz: "UTC", days: { wed: { open: "08:00", close: "17:00" } } }
    expect(isBusinessOpen(utc, new Date("2026-09-30T16:30:00Z"))).toBe(true)
    expect(isBusinessOpen(utc, new Date("2026-09-30T17:00:00Z"))).toBe(false)
    expect(isBusinessOpen(utc, new Date("2026-09-30T07:59:00Z"))).toBe(false)
  })
  it("uses the default tz when tz is missing or invalid", () => {
    const days = { wed: { open: "08:00", close: "17:00" } }
    expect(isBusinessOpen({ days }, sast("2026-09-30T16:59:00"))).toBe(true)
    expect(isBusinessOpen({ tz: "Not/AZone", days }, sast("2026-09-30T17:00:00"))).toBe(false)
    expect(isBusinessOpen({ tz: 5, days }, sast("2026-09-30T16:59:00"))).toBe(true)
  })
})

describe("isBusinessOpen malformed settings", () => {
  const wedOpen = sast("2026-09-30T10:00:00")
  const satOpen = sast("2026-10-03T10:00:00")
  it.each([
    ["a string", "x"],
    ["days not an object", { days: 5 }],
    ["days an array", { days: [] }],
    ["the only day invalid", { days: { mon: { open: "25:99" } } }],
  ])("falls back to default hours for %s", (_n, v) => {
    expect(isBusinessOpen(v, wedOpen)).toBe(true)
    expect(isBusinessOpen(v, satOpen)).toBe(false)
  })
  it("treats one bad day among valid ones as closed", () => {
    const v = {
      days: {
        wed: { open: "25:99", close: "17:00" },
        thu: { open: "08:00", close: "17:00" },
      },
    }
    expect(isBusinessOpen(v, wedOpen)).toBe(false)
    expect(isBusinessOpen(v, sast("2026-10-01T10:00:00"))).toBe(true)
  })
  it("treats an inverted window as closed", () => {
    const v = { days: { wed: { open: "17:00", close: "08:00" }, thu: null } }
    expect(isBusinessOpen(v, wedOpen)).toBe(false)
  })
})

describe("formatBusinessHours", () => {
  const window = (open: string, close: string) => ({ open, close })
  const weekdays = Object.fromEntries(["mon", "tue", "wed", "thu", "fri"].map((d) => [d, window("08:00", "17:00")]))
  it("uses the default hours when the setting is NULL or malformed", () => {
    expect(formatBusinessHours(null)).toBe("Monday to Friday, 08:00 to 17:00")
    expect(formatBusinessHours("x")).toBe("Monday to Friday, 08:00 to 17:00")
  })
  it("joins groups of consecutive days that share times with \"and\"", () => {
    expect(formatBusinessHours({ tz: "Africa/Johannesburg", days: { ...weekdays, sat: window("08:00", "12:00") } }))
      .toBe("Monday to Friday, 08:00 to 17:00 and Saturday, 08:00 to 12:00")
  })
  it("starts a new group where the times change or a day is closed", () => {
    const days = { mon: window("08:00", "17:00"), tue: window("08:00", "17:00"), wed: window("09:00", "17:00"), thu: null, fri: window("08:00", "17:00") }
    expect(formatBusinessHours({ days })).toBe("Monday to Tuesday, 08:00 to 17:00 and Wednesday, 09:00 to 17:00 and Friday, 08:00 to 17:00")
  })
  it("is null when no day is open", () => {
    expect(formatBusinessHours({ days: { mon: null, sat: null } })).toBeNull()
  })
  it("states the tenant's local times, the ones isBusinessOpen uses, not the server's UTC", () => {
    // 06:00Z and 15:00Z are 08:00 and 17:00 in Johannesburg: the line must say 08:00 to 17:00.
    expect(formatBusinessHours({ tz: "Africa/Johannesburg", days: weekdays })).toBe("Monday to Friday, 08:00 to 17:00")
    expect(isBusinessOpen({ tz: "Africa/Johannesburg", days: weekdays }, new Date("2026-09-30T06:00:00Z"))).toBe(true)
    expect(isBusinessOpen({ tz: "Africa/Johannesburg", days: weekdays }, new Date("2026-09-30T15:00:00Z"))).toBe(false)
    // A tenant in UTC shows its own configured times unchanged too.
    expect(formatBusinessHours({ tz: "UTC", days: { wed: window("08:00", "17:00") } })).toBe("Wednesday, 08:00 to 17:00")
  })
})
