import { describe, expect, it } from "vitest"
import { recoveryChargeFreeze } from "./recovery-deadline"

describe("recoveryChargeFreeze", () => {
  it("NCA: freezes from the proceeds date to 10 business days after the final notice", () => {
    // 2026-03-02 is a Monday; no holiday in the window.
    expect(recoveryChargeFreeze({
      regime: "NCA", proceedsAppliedOn: "2026-02-27", finalNoticeIssuedOn: "2026-03-02", nonNcaDemandPeriodDays: 10,
    })).toEqual({ frozenFrom: "2026-02-27", frozenUntil: "2026-03-16" })
  })

  it("NCA: skips the 16 December and 25/26 December holidays in the window", () => {
    // Without holidays 14 Dec + 10 business days would be 28 Dec.
    expect(recoveryChargeFreeze({
      regime: "NCA", proceedsAppliedOn: "2026-12-10", finalNoticeIssuedOn: "2026-12-14", nonNcaDemandPeriodDays: 10,
    }).frozenUntil).toBe("2026-12-30")
  })

  it("NCA: needs a final notice date", () => {
    expect(() => recoveryChargeFreeze({
      regime: "NCA", proceedsAppliedOn: "2026-02-27", nonNcaDemandPeriodDays: 10,
    })).toThrow(/final notice/i)
  })

  it("NCA: refuses a final notice dated before the proceeds", () => {
    expect(() => recoveryChargeFreeze({
      regime: "NCA", proceedsAppliedOn: "2026-02-27", finalNoticeIssuedOn: "2026-02-26", nonNcaDemandPeriodDays: 10,
    })).toThrow(RangeError)
  })

  it("NON_NCA: counts calendar days from the proceeds date, holidays included", () => {
    expect(recoveryChargeFreeze({
      regime: "NON_NCA", proceedsAppliedOn: "2026-12-20", nonNcaDemandPeriodDays: 10,
    })).toEqual({ frozenFrom: "2026-12-20", frozenUntil: "2026-12-30" })
  })

  it("NON_NCA: ignores a final notice date and crosses a year end", () => {
    expect(recoveryChargeFreeze({
      regime: "NON_NCA", proceedsAppliedOn: "2026-12-28", finalNoticeIssuedOn: "2027-03-01", nonNcaDemandPeriodDays: 7,
    }).frozenUntil).toBe("2027-01-04")
  })

  // The database allows a demand period of 1 to 90 days only (CHECK TenantConfig_recovery_settings), so the shortest freeze is one day after the proceeds.
  it("NON_NCA: the shortest period (1 day) freezes the proceeds day and the next, the longest (90 days) runs to the same day three months on", () => {
    expect(recoveryChargeFreeze({
      regime: "NON_NCA", proceedsAppliedOn: "2026-05-05", nonNcaDemandPeriodDays: 1,
    })).toEqual({ frozenFrom: "2026-05-05", frozenUntil: "2026-05-06" })
    // 28 Dec + 3 = 31 Dec, + 31 = 31 Jan, + 28 = 28 Feb, + 28 = 28 Mar: 90 days
    expect(recoveryChargeFreeze({
      regime: "NON_NCA", proceedsAppliedOn: "2026-12-28", nonNcaDemandPeriodDays: 90,
    }).frozenUntil).toBe("2027-03-28")
  })

  it("NCA: a final notice on the Friday before a Monday holiday skips the holiday and the Workers' Day Friday that follows", () => {
    // Fri 24 Apr 2026, Mon 27 Apr (Freedom Day) skipped: Tue 28 (1), Wed 29 (2), Thu 30 (3), Fri 1 May (Workers' Day) skipped,
    // Mon 4 (4), 5 (5), 6 (6), 7 (7), 8 (8), 11 (9), 12 May (10).
    expect(recoveryChargeFreeze({
      regime: "NCA", proceedsAppliedOn: "2026-04-22", finalNoticeIssuedOn: "2026-04-24", nonNcaDemandPeriodDays: 10,
    })).toEqual({ frozenFrom: "2026-04-22", frozenUntil: "2026-05-12" })
  })

  it("NCA: a final notice on the Friday before a holiday that falls on a Sunday skips the Monday that replaces it", () => {
    // Women's Day, 9 Aug 2026, is a Sunday, so Mon 10 Aug is a holiday. Fri 7 Aug notice: Tue 11 (1), 12 (2), 13 (3), 14 (4),
    // Mon 17 (5), 18 (6), 19 (7), 20 (8), 21 (9), Mon 24 Aug (10).
    expect(recoveryChargeFreeze({
      regime: "NCA", proceedsAppliedOn: "2026-08-07", finalNoticeIssuedOn: "2026-08-07", nonNcaDemandPeriodDays: 10,
    })).toEqual({ frozenFrom: "2026-08-07", frozenUntil: "2026-08-24" })
  })

  it("rejects a bad period or date", () => {
    expect(() => recoveryChargeFreeze({
      regime: "NON_NCA", proceedsAppliedOn: "2026-05-05", nonNcaDemandPeriodDays: -1,
    })).toThrow(RangeError)
    expect(() => recoveryChargeFreeze({
      regime: "NON_NCA", proceedsAppliedOn: "2026-05-05", nonNcaDemandPeriodDays: 1.5,
    })).toThrow(RangeError)
    expect(() => recoveryChargeFreeze({
      regime: "NON_NCA", proceedsAppliedOn: "05/05/2026", nonNcaDemandPeriodDays: 10,
    })).toThrow(RangeError)
  })
})
