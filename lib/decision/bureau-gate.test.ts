import { describe, it, expect } from "vitest"
import { evaluateBureauGate, nonOverridableBlock } from "@/lib/decision/bureau-gate"

const base = { score: 650, unscoreable: false, hasAdverse: false, deceased: false, underDebtReview: false, hasJudgement: false, hasNotice: false }
const cfg = { bureauMinScore: 600, bureauBlockAdverse: false }

describe("evaluateBureauGate", () => {
  it("passes a clean, in-band, calibrated check", () => {
    expect(evaluateBureauGate(base, cfg).blocked).toBe(false)
  })
  it("hard-blocks deceased", () => {
    expect(evaluateBureauGate({ ...base, deceased: true }, cfg)).toMatchObject({ blocked: true })
  })
  it("hard-blocks under debt review, judgement, notice", () => {
    expect(evaluateBureauGate({ ...base, underDebtReview: true }, cfg).blocked).toBe(true)
    expect(evaluateBureauGate({ ...base, hasJudgement: true }, cfg).blocked).toBe(true)
    expect(evaluateBureauGate({ ...base, hasNotice: true }, cfg).blocked).toBe(true)
  })
  it("blocks when score below the calibrated floor", () => {
    expect(evaluateBureauGate({ ...base, score: 500 }, cfg).blocked).toBe(true)
  })
  it("treats an uncalibrated floor (<480) as requires-calibration, not a pass", () => {
    const r = evaluateBureauGate(base, { bureauMinScore: 450, bureauBlockAdverse: false })
    expect(r.blocked).toBe(true)
    expect(r.requiresCalibration).toBe(true)
  })
  it("treats a floor exactly at the band floor (480) as calibrated", () => {
    // bureauMinScore === SIGMA_SCORE_MIN is in-band → NOT requires-calibration;
    // a clean 650 check then passes normally.
    const r = evaluateBureauGate(base, { bureauMinScore: 480, bureauBlockAdverse: false })
    expect(r.requiresCalibration).toBeFalsy()
    expect(r.blocked).toBe(false)
  })
  it("blocks unscoreable when calibrated", () => {
    expect(evaluateBureauGate({ ...base, score: null, unscoreable: true }, cfg).blocked).toBe(true)
  })
  it("blocks adverse when bureauBlockAdverse is on", () => {
    expect(evaluateBureauGate({ ...base, hasAdverse: true }, { bureauMinScore: 600, bureauBlockAdverse: true }).blocked).toBe(true)
  })
  it("does not block on adverse when bureauBlockAdverse is off", () => {
    expect(evaluateBureauGate({ ...base, hasAdverse: true }, cfg).blocked).toBe(false)
  })
  it("passes a score exactly at the floor (>= floor is a pass)", () => {
    expect(evaluateBureauGate({ ...base, score: 600 }, cfg).blocked).toBe(false)
  })
})

describe("nonOverridableBlock", () => {
  it("blocks a deceased consumer (cannot be overridden)", () => {
    expect(nonOverridableBlock({ deceased: true }).blocked).toBe(true)
  })
  it("does not block a non-deceased consumer", () => {
    expect(nonOverridableBlock({ deceased: false }).blocked).toBe(false)
  })
})
