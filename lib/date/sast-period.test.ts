import { describe, it, expect } from "vitest"
import { periodFilter, periodQuery, precedingPeriod, resolvePeriod, sastDayStart, PERIOD_KEYS } from "./sast-period"
import { sastHour } from "./sast"

/**
 * South Africa is UTC+02:00 year-round with no DST, so every assertion below
 * can name the exact instant a SAST calendar boundary falls on. Nothing here
 * may depend on the runner's zone: vitest pins TZ=UTC precisely so that a
 * helper which silently uses local time fails instead of passing by accident.
 * `npm run test:tz` re-runs this file under three zones for the same reason.
 */

const at = (iso: string) => new Date(iso)

describe("sastDayStart", () => {
  it("resolves a calendar date to 22:00Z the previous day", () => {
    expect(sastDayStart("2026-08-01").toISOString()).toBe("2026-07-31T22:00:00.000Z")
  })

  it("does not shift across the southern-hemisphere summer (SA has no DST)", () => {
    expect(sastDayStart("2026-01-15").toISOString()).toBe("2026-01-14T22:00:00.000Z")
    expect(sastDayStart("2026-07-15").toISOString()).toBe("2026-07-14T22:00:00.000Z")
  })
})

describe("resolvePeriod — the reported regression", () => {
  // The reported receipt: displayed as "01 Aug 2026, 00:32" in SAST, stored as
  // 2026-07-31T22:32Z. The old UTC boundary sorted it into July while the
  // table sorted it into August. Same row, two months.
  const now = at("2026-08-20T11:07:00.000Z")
  const reportedReceipt = at("2026-07-31T22:32:00.000Z")

  it("includes a 00:32 SAST payment in the month the table shows it in", () => {
    const p = resolvePeriod({ period: "this-month" }, now)
    expect(p.start!.getTime()).toBeLessThanOrEqual(reportedReceipt.getTime())
  })

  it("excludes the last minute of the previous SAST day", () => {
    const p = resolvePeriod({ period: "this-month" }, now)
    // 2026-07-31T21:59Z === 31 Jul 23:59 SAST — genuinely July.
    expect(p.start!.getTime()).toBeGreaterThan(at("2026-07-31T21:59:00.000Z").getTime())
  })

  it("puts the same receipt outside last-month", () => {
    const p = resolvePeriod({ period: "last-month" }, now)
    expect(p.end!.getTime()).toBeLessThanOrEqual(reportedReceipt.getTime())
  })
})

describe("resolvePeriod — half-open ranges", () => {
  const now = at("2026-08-20T11:07:00.000Z")

  it("includes the final SAST day of the month in this-month", () => {
    // 2026-08-31T20:00Z === 31 Aug 22:00 SAST. The old `lte: lastDayAt0000`
    // dropped the entire final day of every month.
    const p = resolvePeriod({ period: "this-month" }, now)
    expect(p.end).toBeNull()
    expect(p.start!.toISOString()).toBe("2026-07-31T22:00:00.000Z")
  })

  it("includes the final SAST day of a custom range", () => {
    const p = resolvePeriod({ period: "custom", from: "2026-08-01", to: "2026-08-31" }, now)
    const lastMoment = at("2026-08-31T20:00:00.000Z")
    expect(p.start!.getTime()).toBeLessThanOrEqual(lastMoment.getTime())
    expect(p.end!.getTime()).toBeGreaterThan(lastMoment.getTime())
    // end is exclusive: the first instant of 1 Sep SAST is out.
    expect(p.end!.toISOString()).toBe("2026-08-31T22:00:00.000Z")
  })

  it("leaves neither gap nor overlap between last-month and this-month", () => {
    const prev = resolvePeriod({ period: "last-month" }, now)
    const cur = resolvePeriod({ period: "this-month" }, now)
    expect(prev.end!.toISOString()).toBe(cur.start!.toISOString())
  })
})

describe("resolvePeriod — boundaries", () => {
  it("starts the week on Monday, not Sunday", () => {
    // 2026-08-20 is a Thursday; the SAST week began Monday 17 Aug.
    const p = resolvePeriod({ period: "this-week" }, at("2026-08-20T11:07:00.000Z"))
    expect(p.start!.toISOString()).toBe("2026-08-16T22:00:00.000Z")
  })

  it("returns the same day's midnight when now IS Monday", () => {
    const p = resolvePeriod({ period: "this-week" }, at("2026-08-17T06:00:00.000Z"))
    expect(p.start!.toISOString()).toBe("2026-08-16T22:00:00.000Z")
  })

  it("treats Sunday as the end of the week it belongs to", () => {
    // 2026-08-23 is a Sunday — still the week that began Monday 17 Aug.
    const p = resolvePeriod({ period: "this-week" }, at("2026-08-23T06:00:00.000Z"))
    expect(p.start!.toISOString()).toBe("2026-08-16T22:00:00.000Z")
  })

  it("uses the SAST calendar day for today, not the UTC one", () => {
    // 2026-08-20T00:30Z === 02:30 SAST, same SAST day.
    const p = resolvePeriod({ period: "today" }, at("2026-08-20T00:30:00.000Z"))
    expect(p.start!.toISOString()).toBe("2026-08-19T22:00:00.000Z")
  })

  // These four are the cases where the SAST calendar day and the UTC calendar
  // day genuinely disagree — late evening UTC is already tomorrow in
  // Johannesburg. Without them the suite passes against a helper that reads
  // plain UTC parts, because for a midday `now` the two agree and every
  // assertion is blind to the difference. Verified by mutation: replacing the
  // +02:00 shift with a bare UTC read leaves the rest of this file green.
  it("uses tomorrow's SAST day when UTC is still on yesterday evening", () => {
    // 2026-08-20T22:30Z === 21 Aug 00:30 SAST.
    const p = resolvePeriod({ period: "today" }, at("2026-08-20T22:30:00.000Z"))
    expect(p.start!.toISOString()).toBe("2026-08-20T22:00:00.000Z")
  })

  it("rolls the SAST week over on Sunday evening UTC", () => {
    // 2026-08-23T22:30Z === Monday 24 Aug 00:30 SAST — a NEW week.
    const p = resolvePeriod({ period: "this-week" }, at("2026-08-23T22:30:00.000Z"))
    expect(p.start!.toISOString()).toBe("2026-08-23T22:00:00.000Z")
  })

  it("rolls the SAST month over on the last evening of the month UTC", () => {
    // 2026-08-31T22:30Z === 1 Sep 00:30 SAST — September, not August.
    const p = resolvePeriod({ period: "this-month" }, at("2026-08-31T22:30:00.000Z"))
    expect(p.start!.toISOString()).toBe("2026-08-31T22:00:00.000Z")
    expect(p.label).toBe("September 2026")
  })

  it("rolls the SAST year over on 31 December evening UTC", () => {
    // 2026-12-31T22:30Z === 1 Jan 2027 00:30 SAST.
    const p = resolvePeriod({ period: "this-year" }, at("2026-12-31T22:30:00.000Z"))
    expect(p.start!.toISOString()).toBe("2026-12-31T22:00:00.000Z")
    expect(p.label).toBe("2027")
  })

  it("names last-month from the SAST month, not the UTC one", () => {
    // 2026-08-31T22:30Z is 1 Sep SAST, so "last month" is August.
    const p = resolvePeriod({ period: "last-month" }, at("2026-08-31T22:30:00.000Z"))
    expect(p.label).toBe("August 2026")
    expect(p.start!.toISOString()).toBe("2026-07-31T22:00:00.000Z")
    expect(p.end!.toISOString()).toBe("2026-08-31T22:00:00.000Z")
  })

  it("rolls last-month back into the previous year on 1 January", () => {
    const p = resolvePeriod({ period: "last-month" }, at("2026-01-01T08:00:00.000Z"))
    expect(p.start!.toISOString()).toBe("2025-11-30T22:00:00.000Z")
    expect(p.end!.toISOString()).toBe("2025-12-31T22:00:00.000Z")
  })

  it("anchors this-year to 1 January SAST", () => {
    const p = resolvePeriod({ period: "this-year" }, at("2026-08-20T11:07:00.000Z"))
    expect(p.start!.toISOString()).toBe("2025-12-31T22:00:00.000Z")
  })

  it("leaves all-time unbounded at both ends", () => {
    const p = resolvePeriod({ period: "all" }, at("2026-08-20T11:07:00.000Z"))
    expect(p.start).toBeNull()
    expect(p.end).toBeNull()
  })
})

describe("resolvePeriod — malformed input never yields an Invalid Date", () => {
  const now = at("2026-08-20T11:07:00.000Z")

  // A NaN boundary makes every Prisma filter silently match nothing, which
  // reads as "no payments" rather than as an error.
  const junk: Array<Record<string, string>> = [
    { period: "custom", from: "2026-02-31", to: "2026-03-01" },
    { period: "custom", from: "banana", to: "2026-03-01" },
    { period: "custom", from: "2026-08-01" },
    { period: "custom", to: "2026-08-31" },
    { period: "custom", from: "2026-08-31", to: "2026-08-01" },
    { period: "not-a-period" },
    { period: "" },
    {},
  ]

  for (const input of junk) {
    it(`falls back to this-month for ${JSON.stringify(input)}`, () => {
      const p = resolvePeriod(input, now)
      expect(Number.isNaN(p.start?.getTime() ?? 0)).toBe(false)
      expect(Number.isNaN(p.end?.getTime() ?? 0)).toBe(false)
      expect(p.key).toBe("this-month")
    })
  }

  it("accepts a well-formed custom range", () => {
    const p = resolvePeriod({ period: "custom", from: "2026-07-01", to: "2026-07-31" }, now)
    expect(p.key).toBe("custom")
    expect(p.start!.toISOString()).toBe("2026-06-30T22:00:00.000Z")
    expect(p.end!.toISOString()).toBe("2026-07-31T22:00:00.000Z")
  })

  it("accepts a single-day custom range", () => {
    const p = resolvePeriod({ period: "custom", from: "2026-07-01", to: "2026-07-01" }, now)
    expect(p.start!.toISOString()).toBe("2026-06-30T22:00:00.000Z")
    expect(p.end!.toISOString()).toBe("2026-07-01T22:00:00.000Z")
  })
})

describe("resolvePeriod — labels", () => {
  const now = at("2026-08-20T11:07:00.000Z")

  it("labels every key with something a card can print", () => {
    for (const key of PERIOD_KEYS) {
      const p = resolvePeriod({ period: key }, now)
      expect(p.label.length).toBeGreaterThan(0)
    }
  })

  it("names the month rather than saying 'last month'", () => {
    expect(resolvePeriod({ period: "last-month" }, now).label).toBe("July 2026")
    expect(resolvePeriod({ period: "this-month" }, now).label).toBe("August 2026")
  })

  it("states the range for a custom period", () => {
    const p = resolvePeriod({ period: "custom", from: "2026-07-01", to: "2026-07-31" }, now)
    expect(p.label).toBe("1 Jul 2026 – 31 Jul 2026")
  })
})

describe("periodFilter", () => {
  const now = at("2026-08-20T11:07:00.000Z")

  it("is undefined for all time, so the caller omits the bound entirely", () => {
    expect(periodFilter(resolvePeriod({ period: "all" }, now))).toBeUndefined()
  })

  it("uses lt, never lte — the bound is exclusive", () => {
    const f = periodFilter(resolvePeriod({ period: "last-month" }, now))!
    expect(f.gte!.toISOString()).toBe("2026-06-30T22:00:00.000Z")
    expect(f.lt!.toISOString()).toBe("2026-07-31T22:00:00.000Z")
    expect("lte" in f).toBe(false)
  })

  it("omits the upper bound for an open-ended period", () => {
    const f = periodFilter(resolvePeriod({ period: "this-month" }, now))!
    expect(f.gte).toBeInstanceOf(Date)
    expect(f.lt).toBeUndefined()
  })
})

describe("periodQuery", () => {
  const now = at("2026-08-20T11:07:00.000Z")

  it("round-trips every preset back to an identical period", () => {
    for (const key of PERIOD_KEYS) {
      if (key === "custom") continue
      const original = resolvePeriod({ period: key }, now)
      const round = resolvePeriod(
        Object.fromEntries(new URLSearchParams(periodQuery(original))),
        now,
      )
      expect(round.key).toBe(original.key)
      expect(round.start?.toISOString() ?? null).toBe(original.start?.toISOString() ?? null)
      expect(round.end?.toISOString() ?? null).toBe(original.end?.toISOString() ?? null)
    }
  })

  it("carries both bounds of a custom range", () => {
    const original = resolvePeriod({ period: "custom", from: "2026-07-01", to: "2026-07-31" }, now)
    const round = resolvePeriod(
      Object.fromEntries(new URLSearchParams(periodQuery(original))),
      now,
    )
    expect(round.key).toBe("custom")
    expect(round.start!.toISOString()).toBe(original.start!.toISOString())
    expect(round.end!.toISOString()).toBe(original.end!.toISOString())
  })
})

describe("precedingPeriod", () => {
  const now = at("2026-08-20T11:07:00.000Z")

  it("compares this month against last month", () => {
    const p = precedingPeriod(resolvePeriod({ period: "this-month" }, now), now)!
    expect(p.label).toBe("July 2026")
  })

  it("compares last month against the month before it", () => {
    const p = precedingPeriod(resolvePeriod({ period: "last-month" }, now), now)!
    expect(p.label).toBe("June 2026")
    expect(p.start!.toISOString()).toBe("2026-05-31T22:00:00.000Z")
    expect(p.end!.toISOString()).toBe("2026-06-30T22:00:00.000Z")
  })

  it("refuses to invent a comparison for all time or an open window", () => {
    // A part-elapsed week measured against a whole one is not a comparison,
    // it is a smaller number wearing a percentage sign.
    for (const key of ["all", "today", "this-week", "this-year"] as const) {
      expect(precedingPeriod(resolvePeriod({ period: key }, now), now)).toBeNull()
    }
  })
})

describe("sastHour", () => {
  // Shipped untested, which a blind reviewer was right to flag: it is the same
  // boundary-shift class the rest of this suite pins, and it drives what the
  // dashboard and portal greet a staff member with.
  it("reads the SAST wall clock, not the container's", () => {
    expect(sastHour(at("2026-08-20T06:00:00.000Z"))).toBe(8)
    expect(sastHour(at("2026-08-20T15:30:00.000Z"))).toBe(17)
  })

  it("rolls over midnight with the SAST day", () => {
    expect(sastHour(at("2026-08-20T21:59:00.000Z"))).toBe(23)
    expect(sastHour(at("2026-08-20T22:00:00.000Z"))).toBe(0)
  })

  it("puts 17:30 SAST in the evening, which the greeting got wrong under UTC", () => {
    // 15:30Z is 17:30 SAST. Reading the UTC hour gave 15 — "Good afternoon".
    expect(sastHour(at("2026-08-20T15:30:00.000Z"))).toBeGreaterThanOrEqual(17)
  })
})
