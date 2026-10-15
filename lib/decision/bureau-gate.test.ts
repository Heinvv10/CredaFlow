import { describe, it, expect, vi, afterEach } from "vitest"
import { evaluateBureauGate, isSimulatedBureauCheck, nonOverridableBlock } from "@/lib/decision/bureau-gate"

const base = { score: 650, unscoreable: false, hasAdverse: false, deceased: false, underDebtReview: false, hasJudgement: false, hasNotice: false, obligations: { totalMonthly: 0 } }
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
  it("sends a report that states no debt to manual review instead of reading it as zero debt", () => {
    for (const obligations of [{ totalMonthly: null }, { simulated: true }, null, undefined]) {
      const r = evaluateBureauGate({ ...base, obligations }, cfg)
      expect(r.blocked).toBe(true)
      expect(r.reason).toMatch(/debt is unknown/)
    }
    // Zero is a statement, not an absence.
    expect(evaluateBureauGate({ ...base, obligations: { totalMonthly: 0 } }, cfg).blocked).toBe(false)
  })
  it("blocks a simulated-bureau row by its provider where the simulator is forbidden", () => {
    vi.stubEnv("NODE_ENV", "production")
    try {
      expect(evaluateBureauGate({ ...base, provider: "simulated" }, cfg).reason).toMatch(/simulated/i)
    } finally {
      vi.unstubAllEnvs()
    }
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

describe("simulated bureau evidence", () => {
  afterEach(() => vi.unstubAllEnvs())
  const simulated = { ...base, obligations: { simulated: true, totalMonthly: 0 } }

  it("reads the marker only when it is exactly true", () => {
    expect(isSimulatedBureauCheck({ simulated: true })).toBe(true)
    expect(isSimulatedBureauCheck({ simulated: "true" })).toBe(false)
    expect(isSimulatedBureauCheck({ totalMonthly: 1 })).toBe(false)
    expect(isSimulatedBureauCheck(null)).toBe(false)
  })

  it("blocks a simulated check on a deployment that forbids Experian simulation", () => {
    vi.stubEnv("NODE_ENV", "production")
    const r = evaluateBureauGate(simulated, cfg)
    expect(r.blocked).toBe(true)
    expect(r.reason).toMatch(/simulated/i)
  })

  it("accepts a simulated check where simulation is permitted (demo, local, tests)", () => {
    vi.stubEnv("NODE_ENV", "development")
    expect(evaluateBureauGate(simulated, cfg).blocked).toBe(false)
  })

  it("accepts a simulated check on a deployed build declared as the UAT estate", () => {
    vi.stubEnv("NODE_ENV", "production")
    vi.stubEnv("EXPERIAN_ENV", "UAT")
    expect(evaluateBureauGate(simulated, cfg).blocked).toBe(false)
  })

  it("never blocks a genuine check on a deployed build", () => {
    vi.stubEnv("NODE_ENV", "production")
    expect(evaluateBureauGate({ ...base, obligations: { totalMonthly: 100 } }, cfg).blocked).toBe(false)
  })
})
