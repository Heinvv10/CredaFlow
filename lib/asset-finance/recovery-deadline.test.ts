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

  it("NON_NCA: a zero-day period freezes the proceeds day only", () => {
    expect(recoveryChargeFreeze({
      regime: "NON_NCA", proceedsAppliedOn: "2026-05-05", nonNcaDemandPeriodDays: 0,
    })).toEqual({ frozenFrom: "2026-05-05", frozenUntil: "2026-05-05" })
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
