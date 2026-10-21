import { describe, expect, it } from "vitest"
import { FIRST_DUE, climbingFrom, history, instalments, loan } from "./__fixtures__/loan-facts"
import { addDays, addMonths, HEADLINE_BAD } from "./definition"
import { loanWindows, windowOutcomes } from "./windows"

const AFTER_12M = addMonths(FIRST_DUE, 13)
const get = (rows: ReturnType<typeof windowOutcomes>, kind: string, window: string) => {
  const row = rows.find((r) => r.outcomeKind === kind && r.window === window)
  if (!row) throw new Error(`no ${kind} ${window}`)
  return [row.state, row.value, row.reasonCode]
}

describe("windows", () => {
  it("are 3, 6 and 12 months from the first due day, clamped to the month's end", () => {
    expect(loanWindows(loan())).toEqual([
      { window: "3M", start: "2026-01-31", end: "2026-04-30" },
      { window: "6M", start: "2026-01-31", end: "2026-07-31" },
      { window: "12M", start: "2026-01-31", end: "2027-01-31" },
    ])
  })

  it("add term end + 30 days only for a short loan (inside the 3M window)", () => {
    const short = loan({ instalments: instalments(1), maturityDay: FIRST_DUE })
    expect(loanWindows(short).at(-1)).toEqual({ window: "TERM_30D", start: FIRST_DUE, end: addDays(FIRST_DUE, 30) })
    expect(loanWindows(loan()).map((w) => w.window)).not.toContain("TERM_30D")
  })

  it("names the headline bad as ever 90+ DPD in 12 months", () => {
    expect(HEADLINE_BAD).toEqual({ outcomeKind: "EVER_90_DPD", window: "12M" })
  })
})

describe("ever 30/60/90 DPD", () => {
  it("are false with a complete clean history once the window has elapsed", () => {
    const rows = windowOutcomes(loan(), AFTER_12M)
    for (const kind of ["EVER_30_DPD", "EVER_60_DPD", "EVER_90_DPD"]) {
      for (const w of ["3M", "6M", "12M"]) expect(get(rows, kind, w)).toEqual(["OBSERVED", false, null])
    }
  })

  it("are true from the day the threshold was reached, per window", () => {
    // Instalment 2 (due 28 Feb) is never paid: 30 DPD on 30 Mar, 60 on 29 Apr, 90 on 29 May.
    const facts = loan({ arrearsHistory: history(FIRST_DUE, AFTER_12M, climbingFrom("2026-02-28")) })
    const rows = windowOutcomes(facts, AFTER_12M)
    expect(get(rows, "EVER_30_DPD", "3M")).toEqual(["OBSERVED", true, null])
    expect(get(rows, "EVER_60_DPD", "3M")).toEqual(["OBSERVED", true, null])
    expect(get(rows, "EVER_90_DPD", "3M")).toEqual(["OBSERVED", false, null])
    expect(get(rows, "EVER_90_DPD", "6M")).toEqual(["OBSERVED", true, null])
    expect(get(rows, HEADLINE_BAD.outcomeKind, HEADLINE_BAD.window)).toEqual(["OBSERVED", true, null])
    expect(rows.find((r) => r.outcomeKind === "EVER_90_DPD" && r.window === "12M")?.observedAt)
      .toEqual(new Date("2026-05-29T00:00:00+02:00"))
  })

  it("stay PENDING until the window has elapsed, even when the threshold was already reached", () => {
    const facts = loan({ arrearsHistory: history(FIRST_DUE, "2026-07-01", climbingFrom("2026-02-28")) })
    const rows = windowOutcomes(facts, "2026-07-01")
    expect(get(rows, "EVER_90_DPD", "3M")).toEqual(["OBSERVED", false, null])
    expect(get(rows, "EVER_90_DPD", "6M")).toEqual(["PENDING", null, null])
    expect(get(rows, "EVER_90_DPD", "12M")).toEqual(["PENDING", null, null])
  })

  it("are UNOBSERVABLE, never good, when a day of history is missing", () => {
    const facts = loan({ arrearsHistory: history(FIRST_DUE, AFTER_12M, () => 0, (d) => d === "2026-06-15") })
    const rows = windowOutcomes(facts, AFTER_12M)
    expect(get(rows, "EVER_30_DPD", "3M")).toEqual(["OBSERVED", false, null])
    for (const kind of ["EVER_30_DPD", "EVER_60_DPD", "EVER_90_DPD", "DEFAULTED_STATUS"]) {
      expect(get(rows, kind, "6M")).toEqual(["UNOBSERVABLE", null, "HISTORY_GAP"])
      expect(get(rows, kind, "12M")).toEqual(["UNOBSERVABLE", null, "HISTORY_GAP"])
    }
    expect(rows.filter((r) => r.state !== "OBSERVED").every((r) => r.value === null)).toBe(true)
  })

  it("treat history that never started (no nightly run yet) as UNOBSERVABLE", () => {
    const rows = windowOutcomes(loan({ arrearsHistory: [] }), AFTER_12M)
    expect(get(rows, "EVER_90_DPD", "12M")).toEqual(["UNOBSERVABLE", null, "HISTORY_GAP"])
  })

  it("are still true when the threshold was seen despite a gap elsewhere", () => {
    const facts = loan({ arrearsHistory: history(FIRST_DUE, AFTER_12M, climbingFrom("2026-02-28"), (d) => d === "2026-02-10") })
    expect(get(windowOutcomes(facts, AFTER_12M), "EVER_30_DPD", "3M")).toEqual(["OBSERVED", true, null])
  })

  it("need no history after a loan closed", () => {
    const facts = loan({ end: { kind: "SETTLED", day: "2026-03-15" }, arrearsHistory: history(FIRST_DUE, "2026-03-15") })
    const rows = windowOutcomes(facts, AFTER_12M)
    expect(get(rows, "EVER_30_DPD", "12M")).toEqual(["OBSERVED", false, null])
    expect(get(rows, "SETTLED", "3M")).toEqual(["OBSERVED", true, null])
    expect(get(rows, "WRITTEN_OFF", "12M")).toEqual(["OBSERVED", false, null])
  })

  it("are UNOBSERVABLE when a closed loan's close date is unknown", () => {
    const facts = loan({ end: { kind: "WRITTEN_OFF", day: null }, arrearsHistory: history(FIRST_DUE, "2026-03-15") })
    const rows = windowOutcomes(facts, AFTER_12M)
    expect(get(rows, "EVER_90_DPD", "12M")).toEqual(["UNOBSERVABLE", null, "CLOSE_DATE_MISSING"])
    expect(get(rows, "WRITTEN_OFF", "12M")).toEqual(["UNOBSERVABLE", null, "CLOSE_DATE_MISSING"])
  })

  it("are UNOBSERVABLE without a schedule", () => {
    const rows = windowOutcomes(loan({ instalments: [] }), AFTER_12M)
    expect(rows.every((r) => r.state === "UNOBSERVABLE" && r.reasonCode === "NO_SCHEDULE")).toBe(true)
    expect(rows).toHaveLength(3 * 7)
  })
})

describe("CURED, DEFAULTED_STATUS, SETTLED, WRITTEN_OFF", () => {
  it("CURED is true when DPD returns to 0 after 30+", () => {
    const dpd = (d: string) => (d >= "2026-03-30" && d < "2026-04-10" ? 30 : 0)
    const rows = windowOutcomes(loan({ arrearsHistory: history(FIRST_DUE, AFTER_12M, dpd) }), AFTER_12M)
    expect(get(rows, "CURED", "3M")).toEqual(["OBSERVED", true, null])
    expect(rows.find((r) => r.outcomeKind === "CURED" && r.window === "3M")?.observedAt).toEqual(new Date("2026-04-10T00:00:00+02:00"))
  })

  it("CURED is true when the loan settles after 30+ DPD", () => {
    const facts = loan({ end: { kind: "SETTLED", day: "2026-04-20" }, arrearsHistory: history(FIRST_DUE, "2026-04-20", climbingFrom("2026-02-28")) })
    expect(get(windowOutcomes(facts, AFTER_12M), "CURED", "6M")).toEqual(["OBSERVED", true, null])
  })

  it("CURED is false (not cured) while still in arrears, and false NEVER_30_DPD for a loan never delinquent", () => {
    const delinquent = windowOutcomes(loan({ arrearsHistory: history(FIRST_DUE, AFTER_12M, climbingFrom("2026-02-28")) }), AFTER_12M)
    expect(get(delinquent, "CURED", "12M")).toEqual(["OBSERVED", false, null])
    expect(get(windowOutcomes(loan(), AFTER_12M), "CURED", "12M")).toEqual(["OBSERVED", false, "NEVER_30_DPD"])
  })

  it("CURED is UNOBSERVABLE when a gap could hide a cure", () => {
    const facts = loan({ arrearsHistory: history(FIRST_DUE, AFTER_12M, climbingFrom("2026-02-28"), (d) => d === "2026-08-01") })
    expect(get(windowOutcomes(facts, AFTER_12M), "CURED", "12M")).toEqual(["UNOBSERVABLE", null, "HISTORY_GAP"])
  })

  it("DEFAULTED_STATUS reads the day's status, separately from DPD", () => {
    const facts = loan({ arrearsHistory: history(FIRST_DUE, AFTER_12M, () => 0, () => false, (d) => d === "2026-05-01") })
    const rows = windowOutcomes(facts, AFTER_12M)
    expect(get(rows, "DEFAULTED_STATUS", "3M")).toEqual(["OBSERVED", false, null])
    expect(get(rows, "DEFAULTED_STATUS", "6M")).toEqual(["OBSERVED", true, null])
    expect(get(rows, "EVER_90_DPD", "6M")).toEqual(["OBSERVED", false, null])
  })

  it("WRITTEN_OFF is true from its write-off day", () => {
    const facts = loan({ end: { kind: "WRITTEN_OFF", day: "2026-09-01" }, arrearsHistory: history(FIRST_DUE, "2026-09-01", climbingFrom("2026-02-28")) })
    const rows = windowOutcomes(facts, AFTER_12M)
    expect(get(rows, "WRITTEN_OFF", "6M")).toEqual(["OBSERVED", false, null])
    expect(get(rows, "WRITTEN_OFF", "12M")).toEqual(["OBSERVED", true, null])
    expect(get(rows, "SETTLED", "12M")).toEqual(["OBSERVED", false, null])
  })
})
