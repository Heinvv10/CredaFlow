import type { CollectionsStage } from "@prisma/client"
import { describe, expect, it } from "vitest"
import { addDays } from "../outcomes/definition"
import { arrangementOutcomes, cureRollByStage, stageEpisodes, type HistoryDay, type LoanHistory } from "./collections"

const START = "2026-06-01"
const DAY_BEFORE: HistoryDay = { day: addDays(START, -1), daysInArrears: 0, stage: "NONE" }
/** A clean day before START, then one row per day from START: [dpd, stage] per day, or null for a missing day. */
function history(days: Array<[number, CollectionsStage] | null>): HistoryDay[] {
  return [DAY_BEFORE, ...days.flatMap((d, i) => (d ? [{ day: addDays(START, i), daysInArrears: d[0], stage: d[1] }] : []))]
}
const loan = (days: HistoryDay[], end: LoanHistory["end"] = { kind: "OPEN", day: null }, loanId = "loan-1"): LoanHistory => ({ loanId, days, end })
const run = (n: number, dpdFrom: number, stage: CollectionsStage, step = 1): Array<[number, CollectionsStage]> =>
  Array.from({ length: n }, (_, i) => [dpdFrom + i * step, stage])
const LATE = "2026-12-31"

describe("stageEpisodes", () => {
  it("cures when the loan is back to 0 DPD inside the horizon", () => {
    const [e] = stageEpisodes(loan(history([...run(5, 5, "SOFT_REMINDER", 0), [0, "SOFT_REMINDER"]])), LATE)
    expect(e).toMatchObject({ stage: "SOFT_REMINDER", startDay: START, result: "CURED" })
  })

  it("rolls when it reaches a later arrears band first, and starts a new episode at the next stage", () => {
    // 25 DPD on SOFT_REMINDER, then 31+ (the 31-60 band) on FORMAL_REMINDER.
    const days = history([...run(6, 25, "SOFT_REMINDER"), ...run(40, 31, "FORMAL_REMINDER")])
    const episodes = stageEpisodes(loan(days), LATE)
    expect(episodes.map((e) => [e.stage, e.result])).toEqual([["SOFT_REMINDER", "ROLLED"], ["FORMAL_REMINDER", "ROLLED"]])
  })

  it("stays when the horizon elapses fully recorded without a cure or roll", () => {
    const [e] = stageEpisodes(loan(history(run(40, 35, "SECTION_129_SENT", 0))), LATE)
    expect(e.result).toBe("STAYED")
  })

  it("is pending until the horizon has elapsed", () => {
    const [e] = stageEpisodes(loan(history(run(10, 35, "SECTION_129_SENT", 0))), addDays(START, 10))
    expect(e.result).toBe("PENDING")
  })

  it("is unobservable, never stayed, when a day in the horizon is missing", () => {
    const days = history([...run(10, 35, "SECTION_129_SENT", 0), null, ...run(30, 35, "SECTION_129_SENT", 0)])
    expect(stageEpisodes(loan(days), LATE).map((e) => e.result)).toEqual(["UNOBSERVABLE"])
  })

  it("a cure seen after a gap is still a cure", () => {
    const days = history([[40, "FORMAL_REMINDER"], null, null, [0, "FORMAL_REMINDER"]])
    expect(stageEpisodes(loan(days), LATE)[0].result).toBe("CURED")
  })

  it("settling inside the horizon cures; a write-off rolls; rows are not needed after the close day", () => {
    const days = history(run(3, 40, "ATTORNEY_REFERRED", 0))
    expect(stageEpisodes(loan(days, { kind: "SETTLED", day: addDays(START, 3) }), LATE)[0].result).toBe("CURED")
    expect(stageEpisodes(loan(days, { kind: "WRITTEN_OFF", day: addDays(START, 3) }), LATE)[0].result).toBe("ROLLED")
    // A close with no date cannot be placed: the missing days make it unobservable.
    expect(stageEpisodes(loan(days, { kind: "SETTLED", day: null }), LATE)[0].result).toBe("UNOBSERVABLE")
  })

  it("starts no episode on the first day read: the day before it is unknown", () => {
    const days = history(run(40, 35, "SECTION_129_SENT", 0)).slice(1)
    expect(stageEpisodes(loan(days), LATE)).toEqual([])
  })

  it("starts no episode at stage WRITTEN_OFF, or on or after the day the loan ended", () => {
    expect(stageEpisodes(loan(history(run(40, 95, "WRITTEN_OFF", 0))), LATE)).toEqual([])
    const days = history([[0, "NONE"], [0, "NONE"], [40, "ATTORNEY_REFERRED"], [41, "ATTORNEY_REFERRED"]])
    expect(stageEpisodes(loan(days, { kind: "SETTLED", day: addDays(START, 2) }), LATE)).toEqual([])
  })

  it("is unobservable, never stayed, when the loan is cancelled inside the horizon", () => {
    const days = history(run(3, 5, "SOFT_REMINDER", 0))
    expect(stageEpisodes(loan(days, { kind: "CANCELLED", day: addDays(START, 3) }), LATE)[0].result).toBe("UNOBSERVABLE")
  })

  it("starts no episode on a day not past due, and a new one after a cure on the same stage", () => {
    const days = history([[0, "NONE"], [3, "NONE"], [0, "NONE"], [4, "NONE"], [0, "NONE"]])
    expect(stageEpisodes(loan(days), LATE).map((e) => [e.startDay, e.result])).toEqual([
      [addDays(START, 1), "CURED"], [addDays(START, 3), "CURED"],
    ])
  })
})

describe("cureRollByStage", () => {
  it("rates cure and roll over resolved episodes only and greys a stage under 20 loans", () => {
    const loans = [
      loan(history([[10, "SOFT_REMINDER"], [0, "SOFT_REMINDER"]]), undefined, "a"),
      loan(history(run(31, 20, "SOFT_REMINDER")), undefined, "b"),
      loan(history(run(5, 10, "SOFT_REMINDER", 0)), undefined, "c"),
    ]
    const [cell] = cureRollByStage(loans, addDays(START, 20))
    // a cured, b rolled (20 → 31 crosses into 31-60), c pending: 1 of 2 resolved each way.
    expect(cell).toMatchObject({ stage: "SOFT_REMINDER", loans: 3, episodes: 3, cured: 1, rolled: 1, pending: 1, cureRatePct: 50, rollRatePct: 50, small: true })
  })
})

describe("arrangementOutcomes", () => {
  it("rates kept and broken over arrangements that ended; active ones are outside the rate", () => {
    expect(arrangementOutcomes({ KEPT: 2, BROKEN: 1, COMPLETED: 1, ACTIVE: 2 })).toEqual({
      total: 6, small: true, active: 2, kept: 2, completedShort: 1, broken: 1, other: 0, keptRatePct: 50, brokenRatePct: 25,
    })
    expect(arrangementOutcomes({}).keptRatePct).toBeNull()
  })
})
