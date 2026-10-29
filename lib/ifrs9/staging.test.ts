import { describe, expect, it } from "vitest"
import { addMonthsIso, classifyStage, stageTriggers, type PriorStaging, type StagingInput } from "./staging"
import { DEFAULT_SETTINGS, type Ifrs9Settings } from "./types"

const loan = (over: Partial<StagingInput> = {}): StagingInput => ({
  dpd: 0, status: "ACTIVE", collectionsStage: "NONE", debtReview: false, flags: [], ...over,
})
const policy = (over: Partial<Ifrs9Settings> = {}): Ifrs9Settings => ({ ...DEFAULT_SETTINGS, enabled: true, ...over })

describe("addMonthsIso", () => {
  it("adds calendar months and clamps to the end of a shorter month", () => {
    expect(addMonthsIso("2026-01-15", 3)).toBe("2026-04-15")
    expect(addMonthsIso("2026-01-31", 1)).toBe("2026-02-28")
    expect(addMonthsIso("2028-01-31", 1)).toBe("2028-02-29")
    expect(addMonthsIso("2026-11-30", 3)).toBe("2027-02-28")
    expect(addMonthsIso("2026-05-10", 0)).toBe("2026-05-10")
  })
})

describe("stageTriggers", () => {
  it("is Stage 1 for a performing loan and for 30 days past due (SICR needs MORE than 30)", () => {
    expect(stageTriggers(loan(), policy())).toEqual({ stage: 1, reasons: [] })
    expect(stageTriggers(loan({ dpd: 30 }), policy()).stage).toBe(1)
  })

  it("is Stage 2 from 31 days past due", () => {
    expect(stageTriggers(loan({ dpd: 31 }), policy())).toEqual({ stage: 2, reasons: ["DPD_OVER_SICR_THRESHOLD"] })
  })

  it("is Stage 3 at exactly 90 days past due (the product's NPL boundary), not 89", () => {
    expect(stageTriggers(loan({ dpd: 89 }), policy()).stage).toBe(2)
    expect(stageTriggers(loan({ dpd: 90 }), policy())).toEqual({ stage: 3, reasons: ["DPD_AT_DEFAULT_THRESHOLD"] })
  })

  it("honours the lender's own thresholds", () => {
    const p = policy({ sicrDpdOver: 15, defaultDpd: 60 })
    expect(stageTriggers(loan({ dpd: 15 }), p).stage).toBe(1)
    expect(stageTriggers(loan({ dpd: 16 }), p).stage).toBe(2)
    expect(stageTriggers(loan({ dpd: 60 }), p).stage).toBe(3)
  })

  it("puts a restructured loan, a debt-review loan and a flagged loan in Stage 2, each switchable", () => {
    expect(stageTriggers(loan({ status: "RESTRUCTURED" }), policy())).toEqual({ stage: 2, reasons: ["RESTRUCTURED"] })
    expect(stageTriggers(loan({ status: "RESTRUCTURED" }), policy({ restructuredStage: 1 })).stage).toBe(1)
    expect(stageTriggers(loan({ debtReview: true }), policy())).toEqual({ stage: 2, reasons: ["DEBT_REVIEW"] })
    expect(stageTriggers(loan({ debtReview: true }), policy({ debtReviewStage: 1 })).stage).toBe(1)
    expect(stageTriggers(loan({ flags: ["BUREAU_DOWNGRADE", "WATCHLIST"] }), policy())).toEqual({
      stage: 2, reasons: ["FLAG_BUREAU_DOWNGRADE", "FLAG_WATCHLIST"],
    })
  })

  it("puts a defaulted, pending-write-off or legal loan in Stage 3 whatever its days past due", () => {
    expect(stageTriggers(loan({ status: "DEFAULTED" }), policy())).toEqual({ stage: 3, reasons: ["STATUS_DEFAULTED"] })
    expect(stageTriggers(loan({ status: "PENDING_WRITE_OFF" }), policy())).toEqual({ stage: 3, reasons: ["PENDING_WRITE_OFF"] })
    expect(stageTriggers(loan({ collectionsStage: "ATTORNEY_REFERRED" }), policy())).toEqual({ stage: 3, reasons: ["LEGAL_ACTION"] })
  })

  it("lists every Stage 3 trigger that fires and ignores Stage 2 reasons once in Stage 3", () => {
    const t = stageTriggers(loan({ dpd: 120, status: "DEFAULTED", collectionsStage: "ATTORNEY_REFERRED", debtReview: true }), policy())
    expect(t).toEqual({ stage: 3, reasons: ["DPD_AT_DEFAULT_THRESHOLD", "STATUS_DEFAULTED", "LEGAL_ACTION"] })
  })
})

describe("classifyStage: cure and probation", () => {
  const p = policy({ stage2ProbationMonths: 3, stage3ProbationMonths: 6 })

  it("starts a first-seen loan at its trigger stage", () => {
    expect(classifyStage(loan({ dpd: 45 }), p, null, "2026-10-31")).toMatchObject({
      stage: 2, triggerStage: 2, stageSince: "2026-10-31", cureStartedOn: null, inProbation: false,
    })
  })

  it("moves up immediately and keeps stageSince while the stage is unchanged", () => {
    const up = classifyStage(loan({ dpd: 95 }), p, { stage: 2, stageSince: "2026-09-30", cureStartedOn: null, restructured: false }, "2026-10-31")
    expect(up).toMatchObject({ stage: 3, stageSince: "2026-10-31" })
    const same = classifyStage(loan({ dpd: 50 }), p, { stage: 2, stageSince: "2026-09-30", cureStartedOn: null, restructured: false }, "2026-10-31")
    expect(same).toMatchObject({ stage: 2, stageSince: "2026-09-30" })
  })

  it("holds Stage 2 through the probation after the triggers clear, then returns to Stage 1", () => {
    const first = classifyStage(loan(), p, { stage: 2, stageSince: "2026-06-30", cureStartedOn: null, restructured: false }, "2026-07-31")
    expect(first).toMatchObject({ stage: 2, inProbation: true, cureStartedOn: "2026-07-31", reasons: ["PROBATION_FROM_STAGE_2"] })
    const before = classifyStage(loan(), p, { stage: 2, stageSince: "2026-06-30", cureStartedOn: "2026-07-31", restructured: false }, "2026-10-30")
    expect(before).toMatchObject({ stage: 2, inProbation: true })
    const after = classifyStage(loan(), p, { stage: 2, stageSince: "2026-06-30", cureStartedOn: "2026-07-31", restructured: false }, "2026-10-31")
    expect(after).toMatchObject({ stage: 1, stageSince: "2026-10-31", cureStartedOn: null, inProbation: false })
  })

  it("steps Stage 3 down to Stage 2 after its probation, then runs the Stage 2 probation from that date", () => {
    const down = classifyStage(loan({ dpd: 40 }), p, { stage: 3, stageSince: "2026-01-31", cureStartedOn: "2026-02-28", restructured: false }, "2026-08-31")
    expect(down).toMatchObject({ stage: 2, stageSince: "2026-08-31", cureStartedOn: null, inProbation: false })
    const full = classifyStage(loan(), p, { stage: 3, stageSince: "2026-01-31", cureStartedOn: "2026-02-28", restructured: false }, "2026-08-31")
    expect(full).toMatchObject({ stage: 2, stageSince: "2026-08-31", cureStartedOn: "2026-08-31", inProbation: true })
    const still = classifyStage(loan(), p, { stage: 3, stageSince: "2026-01-31", cureStartedOn: "2026-02-28", restructured: false }, "2026-08-27")
    expect(still).toMatchObject({ stage: 3, inProbation: true, reasons: ["PROBATION_FROM_STAGE_3"] })
  })

  it("restarts the probation when a trigger fires again before it ends", () => {
    const relapse = classifyStage(loan({ dpd: 40 }), p, { stage: 2, stageSince: "2026-06-30", cureStartedOn: "2026-07-31", restructured: false }, "2026-08-31")
    expect(relapse).toMatchObject({ stage: 2, cureStartedOn: null, inProbation: false, reasons: ["DPD_OVER_SICR_THRESHOLD"] })
    const fresh = classifyStage(loan(), p, { stage: 2, stageSince: "2026-06-30", cureStartedOn: null, restructured: false }, "2026-09-30")
    expect(fresh.cureStartedOn).toBe("2026-09-30")
  })

  it("with no probation configured, steps all the way down in one run", () => {
    const none = policy({ stage2ProbationMonths: 0, stage3ProbationMonths: 0 })
    expect(classifyStage(loan(), none, { stage: 3, stageSince: "2026-01-31", cureStartedOn: null, restructured: false }, "2026-10-31")).toMatchObject({ stage: 1, cureStartedOn: null })
  })
})

describe("restructured and debt-review mapping", () => {
  it("maps each to the stage the lender chose, including Stage 3 and no effect", () => {
    expect(stageTriggers(loan({ status: "RESTRUCTURED" }), policy({ restructuredStage: 3 }))).toEqual({ stage: 3, reasons: ["RESTRUCTURED"] })
    expect(stageTriggers(loan({ debtReview: true }), policy({ debtReviewStage: 3 }))).toEqual({ stage: 3, reasons: ["DEBT_REVIEW"] })
    expect(stageTriggers(loan({ status: "RESTRUCTURED", dpd: 45 }), policy({ restructuredStage: 1 }))).toEqual({ stage: 2, reasons: ["DPD_OVER_SICR_THRESHOLD"] })
  })

  it("does not treat a WRITTEN_OFF status as a trigger (a written-off loan is outside the book the run stages)", () => {
    expect(stageTriggers(loan({ status: "WRITTEN_OFF" }), policy()).stage).toBe(1)
  })
})

describe("restructure probation", () => {
  const p = policy({ stage2ProbationMonths: 3, restructuredProbationMonths: 12 })
  const prior = (restructured: boolean) => ({ stage: 2 as const, stageSince: "2026-01-31", cureStartedOn: null, restructured })

  it("keeps a formerly restructured loan in Stage 2 for the longer restructure probation, and says why", () => {
    const first = classifyStage(loan(), p, prior(true), "2026-06-30")
    expect(first).toMatchObject({ stage: 2, inProbation: true, cureStartedOn: "2026-06-30", reasons: ["PROBATION_FROM_STAGE_2", "RESTRUCTURE_PROBATION"] })
    const at11 = classifyStage(loan(), p, { stage: 2, stageSince: "2026-01-31", cureStartedOn: "2026-06-30", restructured: true }, "2027-05-31")
    expect(at11.stage).toBe(2)
    const at12 = classifyStage(loan(), p, { stage: 2, stageSince: "2026-01-31", cureStartedOn: "2026-06-30", restructured: true }, "2027-06-30")
    expect(at12).toMatchObject({ stage: 1, inProbation: false })
  })

  it("uses only the ordinary probation for a loan that was never restructured", () => {
    expect(classifyStage(loan(), p, { stage: 2, stageSince: "2026-01-31", cureStartedOn: "2026-06-30", restructured: false }, "2026-09-30").stage).toBe(1)
  })
})

describe("partial relapse in Stage 3 probation", () => {
  const p = policy({ stage3ProbationMonths: 6, stage2ProbationMonths: 3 })

  it("does not restart the default-cure clock when only a Stage 2 trigger fires again: it steps down to Stage 2, not 1", () => {
    const prior = { stage: 3 as const, stageSince: "2026-01-31", cureStartedOn: "2026-02-28", restructured: false }
    expect(classifyStage(loan({ dpd: 40 }), p, prior, "2026-08-27")).toMatchObject({ stage: 3, inProbation: true })
    expect(classifyStage(loan({ dpd: 40 }), p, prior, "2026-08-28")).toMatchObject({ stage: 2, triggerStage: 2, inProbation: false, stageSince: "2026-08-28" })
  })

  it("restarts it when a Stage 3 trigger fires again", () => {
    const prior = { stage: 3 as const, stageSince: "2026-01-31", cureStartedOn: "2026-02-28", restructured: false }
    expect(classifyStage(loan({ dpd: 95 }), p, prior, "2026-08-31")).toMatchObject({ stage: 3, cureStartedOn: null, inProbation: false })
  })
})

// Review breaker 6 (PR #255 round 2): the restructure marker is stored on the snapshot, so a Stage 3 trigger winning the
// stage no longer loses it, and the longer probation applies to a loan that is RESTRUCTURED now whatever its prior said.
describe("the restructured marker", () => {
  const p = policy({ stage3ProbationMonths: 6, stage2ProbationMonths: 3, restructuredProbationMonths: 12 })
  const next = (prior: PriorStaging, result: ReturnType<typeof classifyStage>): PriorStaging => ({
    stage: result.stage, stageSince: result.stageSince, cureStartedOn: result.cureStartedOn, restructured: result.restructured,
  })
  const monthEnd = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10)

  it("is kept when a default trigger wins the stage, so the loan still serves the longer probation once it is ACTIVE again", () => {
    const sep = classifyStage(loan({ dpd: 120, status: "RESTRUCTURED" }), p, null, "2026-09-30")
    expect(sep).toMatchObject({ stage: 3, restructured: true })
    // October: arrears capitalised by the restructure, 0 days past due, still RESTRUCTURED (Stage 2 by default mapping)
    const oct = classifyStage(loan({ status: "RESTRUCTURED" }), p, { stage: 3, stageSince: "2026-09-30", cureStartedOn: null, restructured: sep.restructured }, "2026-10-31")
    expect(oct).toMatchObject({ stage: 3, inProbation: true, restructured: true, reasons: ["PROBATION_FROM_STAGE_3", "RESTRUCTURE_PROBATION"] })
    // from November the status is ACTIVE; walk month by month: Stage 3 is held 12 months from the cure start (31 Oct), not 6
    let prior: PriorStaging = { stage: oct.stage, stageSince: oct.stageSince, cureStartedOn: oct.cureStartedOn, restructured: oct.restructured }
    const path: string[] = []
    for (let i = 0; i < 14; i++) {
      const date = monthEnd(2026 + Math.floor((10 + i) / 12), ((10 + i) % 12) + 1)
      const r = classifyStage(loan(), p, prior, date)
      path.push(`${date}:S${r.stage}`)
      prior = next(prior, r)
    }
    // Stage 3 ends 12 months after 31 Oct 2026 (not 6), then 12 more in Stage 2: each step serves the longer of the two
    expect(path).toContain("2027-09-30:S3")
    expect(path).toContain("2027-10-31:S2")
    expect(path).toContain("2027-11-30:S2")
  })

  it("is dropped once the loan has served it and is back at its trigger stage", () => {
    const back = classifyStage(loan(), p, { stage: 2, stageSince: "2026-01-31", cureStartedOn: "2026-06-30", restructured: true }, "2027-06-30")
    expect(back).toMatchObject({ stage: 1, restructured: false })
  })

  it("applies to a loan that is RESTRUCTURED now even when its prior snapshot did not carry the marker", () => {
    const prior = { stage: 3 as const, stageSince: "2026-01-31", cureStartedOn: "2026-02-28", restructured: false }
    expect(classifyStage(loan({ status: "RESTRUCTURED" }), policy({ stage3ProbationMonths: 6, restructuredProbationMonths: 12 }), prior, "2026-09-30"))
      .toMatchObject({ stage: 3, inProbation: true, restructured: true })
  })

  it("is kept when a default trigger wins again on a loan that is RESTRUCTURED, or that carried the marker and is ACTIVE again", () => {
    const prior = { stage: 3 as const, stageSince: "2026-09-30", cureStartedOn: null, restructured: true }
    expect(classifyStage(loan({ dpd: 120, status: "RESTRUCTURED" }), p, { ...prior, restructured: false }, "2026-10-31")).toMatchObject({ stage: 3, restructured: true })
    expect(classifyStage(loan({ dpd: 120 }), p, prior, "2026-10-31")).toMatchObject({ stage: 3, inProbation: false, restructured: true })
    expect(classifyStage(loan({ dpd: 120 }), p, { ...prior, restructured: false }, "2026-10-31")).toMatchObject({ stage: 3, restructured: false })
  })

  it("is shed by a loan whose triggers have all cleared at Stage 1", () => {
    expect(classifyStage(loan(), p, { stage: 1, stageSince: "2026-01-31", cureStartedOn: null, restructured: true }, "2026-10-31")).toMatchObject({ stage: 1, restructured: false })
  })

  it("a loan leaving debt review cures on the probation of the stage the lender mapped it to", () => {
    const s3 = policy({ debtReviewStage: 3 })
    const a = classifyStage(loan({ debtReview: true }), s3, null, "2026-09-30")
    expect(a.stage).toBe(3)
    const b = classifyStage(loan(), s3, { stage: 3, stageSince: a.stageSince, cureStartedOn: a.cureStartedOn, restructured: false }, "2026-10-31")
    expect(b).toMatchObject({ stage: 3, inProbation: true, restructured: false })
  })
})
