import { describe, it, expect } from "vitest"
import {
  parseInsuranceDateInput,
  parseInsuranceExpiryInput,
} from "@/lib/insurance/parse-date-input"

// SAST is UTC+2. 2026-08-17T09:15:00Z is 11:15 on 17 August in Johannesburg.
const NOW = new Date("2026-08-17T09:15:00.000Z")

describe("parseInsuranceDateInput", () => {
  describe("a date-only string naming today", () => {
    // THE BUG THIS EXISTS FOR. A rate card activated at 07:39 this morning
    // could not be quoted against today, because "2026-08-17" parsed to
    // midnight UTC — hours before the card came into force — and the quote
    // refused with RATE_TABLE_UNRESOLVED. The same string at the bind seam
    // tripped "cover cannot be backdated". Both are the same misreading: a
    // caller who writes today's date means "now", not "the first instant of
    // today".
    it("resolves to now, not to midnight", () => {
      expect(parseInsuranceDateInput("2026-08-17", NOW)).toEqual(NOW)
    })

    it("is still today when the SAST calendar day is ahead of the UTC one", () => {
      // 22:30 UTC on the 17th is 00:30 on the 18th in SAST. A caller in
      // Johannesburg writing "today" means the 18th.
      const lateNight = new Date("2026-08-17T22:30:00.000Z")
      expect(parseInsuranceDateInput("2026-08-18", lateNight)).toEqual(lateNight)
      // ...and the UTC calendar day is now yesterday, so it must NOT be now.
      expect(parseInsuranceDateInput("2026-08-17", lateNight)).toEqual(
        new Date("2026-08-16T22:00:00.000Z")
      )
    })
  })

  describe("a date-only string naming another day", () => {
    it("resolves a past date to SAST midnight, which stays in the past", () => {
      // 00:00 SAST on the 16th is 22:00 UTC on the 15th.
      expect(parseInsuranceDateInput("2026-08-16", NOW)).toEqual(
        new Date("2026-08-15T22:00:00.000Z")
      )
    })

    it("resolves a future date to SAST midnight, which stays in the future", () => {
      expect(parseInsuranceDateInput("2026-08-18", NOW)).toEqual(
        new Date("2026-08-17T22:00:00.000Z")
      )
    })

    it("does not shift a past date forward into now", () => {
      // The guards downstream compare against `now`. If a back-dated string
      // ever resolved to `now`, back-dating would become unrefusable — the
      // control at bind.ts would pass on every input it exists to reject.
      const backdated = parseInsuranceDateInput("2020-01-01", NOW)
      expect(backdated).not.toBeNull()
      expect(backdated!.getTime()).toBeLessThan(NOW.getTime())
    })
  })

  describe("a full timestamp", () => {
    it("is honoured verbatim, including one that lands on today", () => {
      expect(parseInsuranceDateInput("2026-08-17T05:00:00.000Z", NOW)).toEqual(
        new Date("2026-08-17T05:00:00.000Z")
      )
    })
  })

  describe("a date-only string that is padded or loosely shaped", () => {
    // A leading space fails an anchored regex, so a strict shape test alone
    // sends `" 2026-08-17"` down the `new Date()` path — straight back to
    // midnight, which is the bug this helper removes. The whitespace is the
    // whole exploit.
    it("still means now when padded with whitespace", () => {
      expect(parseInsuranceDateInput(" 2026-08-17", NOW)).toEqual(NOW)
      expect(parseInsuranceDateInput("2026-08-17 ", NOW)).toEqual(NOW)
      expect(parseInsuranceDateInput("\t2026-08-17\n", NOW)).toEqual(NOW)
    })

    it("still resolves to SAST midnight when a padded date names another day", () => {
      expect(parseInsuranceDateInput("  2026-08-16  ", NOW)).toEqual(
        new Date("2026-08-15T22:00:00.000Z")
      )
    })

    it("refuses a non-zero-padded date rather than reading it in the runtime's timezone", () => {
      // `new Date("2026-8-17")` is midnight LOCAL — UTC in the container, SAST
      // on a developer's machine. Same request, different day, depending where
      // it ran. Refusing is the only answer that is the same everywhere.
      expect(parseInsuranceDateInput("2026-8-17", NOW)).toBeNull()
      expect(parseInsuranceDateInput("26-08-17", NOW)).toBeNull()
    })
  })

  describe("input that is not a date", () => {
    it("returns null for gibberish", () => {
      expect(parseInsuranceDateInput("not a date", NOW)).toBeNull()
    })

    it("returns null for an empty string", () => {
      expect(parseInsuranceDateInput("", NOW)).toBeNull()
    })

    it("returns null for a calendar-invalid date that would silently roll over", () => {
      // `new Date("2026-02-30")` is not NaN — it rolls to 2 March. Accepting it
      // would price a quote against a day the caller never named.
      expect(parseInsuranceDateInput("2026-02-30", NOW)).toBeNull()
      expect(parseInsuranceDateInput("2026-13-01", NOW)).toBeNull()
    })
  })
})

describe("parseInsuranceExpiryInput", () => {
  // An expiry is an END boundary, so a bare date means the LAST day the quote
  // is valid — not the first instant of it. Reusing parseInsuranceDateInput
  // here would be a bug wearing a fix: it resolves "2026-08-24" to midnight
  // SAST ON the 24th, killing the quote before the day it names has started.
  it("resolves a bare date to the END of that SAST day", () => {
    // Midnight SAST starting the 25th is 22:00 UTC on the 24th.
    expect(parseInsuranceExpiryInput("2026-08-24")).toEqual(
      new Date("2026-08-24T22:00:00.000Z")
    )
  })

  it("keeps a quote dated to expire today alive for the rest of today", () => {
    const endOfToday = parseInsuranceExpiryInput("2026-08-17")
    expect(endOfToday).not.toBeNull()
    // Emphatically NOT `now` — that would expire the quote the instant it was
    // written, which is what the sibling helper's "today means now" rule does.
    expect(endOfToday!.getTime()).toBeGreaterThan(NOW.getTime())
    expect(endOfToday).toEqual(new Date("2026-08-17T22:00:00.000Z"))
  })

  it("honours a full timestamp verbatim", () => {
    expect(parseInsuranceExpiryInput("2026-08-24T09:00:00.000Z")).toEqual(
      new Date("2026-08-24T09:00:00.000Z")
    )
  })

  it("trims, and refuses loose or calendar-invalid dates", () => {
    expect(parseInsuranceExpiryInput("  2026-08-24  ")).toEqual(
      new Date("2026-08-24T22:00:00.000Z")
    )
    expect(parseInsuranceExpiryInput("2026-8-24")).toBeNull()
    expect(parseInsuranceExpiryInput("2026-02-30")).toBeNull()
    expect(parseInsuranceExpiryInput("not a date")).toBeNull()
  })
})
