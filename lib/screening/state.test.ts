import { describe, expect, it } from "vitest"
import {
  amlStatusFor,
  deriveScreeningState,
  needsRerun,
  reviewEligibility,
  screeningAllowsApproval,
  type ScreeningCheckFacts,
} from "./state"
import { SCREENING_TYPES } from "./types"

const FP = "fp-current"
const clear = (type: ScreeningCheckFacts["type"], id = `c-${type}`): ScreeningCheckFacts =>
  ({ id, type, result: "CLEAR", decision: null, simulated: false, subjectFingerprint: FP })
const run = (...over: Array<Omit<ScreeningCheckFacts, "subjectFingerprint"> & { subjectFingerprint?: string | null }>): ScreeningCheckFacts[] =>
  (["PEP", "SANCTIONS", "ADVERSE_MEDIA"] as const).map((t) => {
    const o = over.find((x) => x.type === t)
    return o ? { subjectFingerprint: FP, ...o } : clear(t)
  })
const derive = (latestRun: ScreeningCheckFacts[], over: Partial<Parameters<typeof deriveScreeningState>[0]> = {}) =>
  deriveScreeningState({
    configured: true, latestRun, simulationPermitted: true, expectedTypes: SCREENING_TYPES,
    currentFingerprint: FP, activeBlockCheckIds: [], ...over,
  })

describe("deriveScreeningState", () => {
  it("is NOT_CONFIGURED without a provider, which allows approval and writes nothing", () => {
    const s = derive([], { configured: false })
    expect(s.state).toBe("NOT_CONFIGURED")
    expect(screeningAllowsApproval(s)).toBe(true)
    expect(amlStatusFor(s)).toBeNull()
  })

  it("blocks a configured lender's subject who was never screened", () => {
    const s = derive([])
    expect(s.state).toBe("NOT_SCREENED")
    expect(screeningAllowsApproval(s)).toBe(false)
    expect(needsRerun(s)).toBe(true)
    expect(amlStatusFor(s)).toBe("PENDING")
  })

  it("is CLEAR when every type is clear for the current identity", () => {
    const s = derive(run())
    expect(s.state).toBe("CLEAR")
    expect(screeningAllowsApproval(s)).toBe(true)
    expect(amlStatusFor(s)).toBe("CLEARED")
  })

  it("H1: a run of another identity is NOT_SCREENED (subject changed), never CLEAR", () => {
    expect(derive(run(), { currentFingerprint: "fp-renamed" })).toEqual({ state: "NOT_SCREENED", reason: "SUBJECT_CHANGED" })
    expect(derive(run(), { currentFingerprint: null }).state).toBe("NOT_SCREENED")
    const legacy = run().map((c) => ({ ...c, subjectFingerprint: null }))
    expect(derive(legacy).state).toBe("NOT_SCREENED")
  })

  it("H2: an unlifted sticky block blocks even when the latest run is clear", () => {
    const s = derive(run(), { activeBlockCheckIds: ["old-sanctions"] })
    expect(s).toEqual({ state: "BLOCKED", reason: "STICKY_BLOCK", checkIds: ["old-sanctions"] })
    expect(screeningAllowsApproval(s)).toBe(false)
    expect(needsRerun(s)).toBe(false)
  })

  it("H2: a sticky block outranks an identity change", () => {
    expect(derive(run(), { activeBlockCheckIds: ["b"], currentFingerprint: "fp-renamed" }).state).toBe("BLOCKED")
  })

  it("refers an undecided PEP match and blocks approval until it is decided", () => {
    const s = derive(run({ id: "pep", type: "PEP", result: "CONFIRMED_MATCH", decision: null, simulated: false }))
    expect(s).toEqual({ state: "REFER", checkIds: ["pep"] })
    expect(screeningAllowsApproval(s)).toBe(false)
    expect(amlStatusFor(s)).toBe("FLAGGED")
  })

  it("clears once the PEP match is ACCEPTED or found a FALSE_POSITIVE", () => {
    for (const decision of ["ACCEPTED", "FALSE_POSITIVE"] as const) {
      expect(derive(run({ id: "pep", type: "PEP", result: "CONFIRMED_MATCH", decision, simulated: false })).state, decision).toBe("CLEAR")
    }
  })

  it("hard-blocks a confirmed sanctions match, even beside other decided matches", () => {
    const s = derive(run(
      { id: "s", type: "SANCTIONS", result: "CONFIRMED_MATCH", decision: null, simulated: false },
      { id: "pep", type: "PEP", result: "CONFIRMED_MATCH", decision: "ACCEPTED", simulated: false },
    ))
    expect(s).toEqual({ state: "BLOCKED", reason: "SANCTIONS_MATCH", checkIds: ["s"] })
  })

  it("hard-blocks a REJECTED match", () => {
    expect(derive(run({ id: "m", type: "ADVERSE_MEDIA", result: "CONFIRMED_MATCH", decision: "REJECTED", simulated: false })))
      .toMatchObject({ state: "BLOCKED", reason: "REJECTED" })
  })

  it("is INCOMPLETE on a provider error or a missing supported type, and asks for a re-run", () => {
    const errored = derive(run({ id: "e", type: "PEP", result: "ERROR", decision: null, simulated: false }))
    expect(errored).toEqual({ state: "INCOMPLETE", checkIds: ["e"] })
    expect(needsRerun(errored)).toBe(true)
    expect(derive([clear("PEP"), clear("SANCTIONS")]).state).toBe("INCOMPLETE")
  })

  it("A2: a type the provider does not screen is not missing", () => {
    expect(derive([clear("PEP"), clear("SANCTIONS")], { expectedTypes: ["PEP", "SANCTIONS"] }).state).toBe("CLEAR")
  })

  it("does not accept a simulated clear where simulation is forbidden", () => {
    const sim = run().map((c) => ({ ...c, simulated: true }))
    expect(derive(sim).state).toBe("CLEAR")
    expect(derive(sim, { simulationPermitted: false })).toMatchObject({ state: "BLOCKED", reason: "SIMULATED_NOT_PERMITTED" })
  })
})

describe("reviewEligibility", () => {
  const policy = { reviewMinRole: "ADMIN" as const, requireStaffTotp: true, requireSecondReviewer: true }
  const admin = { id: "admin", role: "ADMIN" as const, totpVerified: true }
  const pep = { type: "PEP" as const, result: "CONFIRMED_MATCH" as const, decision: null, triggeredById: "officer" }

  it("lets a senior with 2FA decide a PEP match someone else's run raised", () => {
    for (const decision of ["ACCEPTED", "FALSE_POSITIVE", "REJECTED"] as const) {
      expect(reviewEligibility({ check: pep, decision, policy, caller: admin })).toEqual({ allowed: true })
    }
  })

  it("maker-checker: never the user who started the run, while the lender requires a second reviewer", () => {
    expect(reviewEligibility({ check: { ...pep, triggeredById: "admin" }, decision: "ACCEPTED", policy, caller: admin }))
      .toEqual({ allowed: false, code: "own_run" })
    expect(reviewEligibility({ check: { ...pep, triggeredById: null }, decision: "ACCEPTED", policy, caller: admin })).toEqual({ allowed: true })
    expect(reviewEligibility({ check: { ...pep, triggeredById: "admin" }, decision: "ACCEPTED", policy: { ...policy, requireSecondReviewer: false }, caller: admin }))
      .toEqual({ allowed: true })
  })

  it("never clears a confirmed sanctions match, whoever asks and whatever the decision", () => {
    const check = { type: "SANCTIONS" as const, result: "CONFIRMED_MATCH" as const, decision: null, triggeredById: null }
    for (const decision of ["ACCEPTED", "FALSE_POSITIVE", "REJECTED"] as const) {
      expect(reviewEligibility({ check, decision, policy, caller: { id: "sa", role: "SUPER_ADMIN", totpVerified: true } }))
        .toEqual({ allowed: false, code: "sanctions_not_clearable" })
    }
  })

  it("never ACCEPTS a possible sanctions match, but allows a false positive", () => {
    const check = { type: "SANCTIONS" as const, result: "POSSIBLE_MATCH" as const, decision: null, triggeredById: null }
    expect(reviewEligibility({ check, decision: "ACCEPTED", policy, caller: admin })).toEqual({ allowed: false, code: "sanctions_not_acceptable" })
    expect(reviewEligibility({ check, decision: "FALSE_POSITIVE", policy, caller: admin })).toEqual({ allowed: true })
  })

  it("refuses a role below the lender's minimum, and missing 2FA when the lender requires it", () => {
    expect(reviewEligibility({ check: pep, decision: "ACCEPTED", policy, caller: { id: "m", role: "BRANCH_MANAGER", totpVerified: true } }))
      .toEqual({ allowed: false, code: "role_below_policy" })
    expect(reviewEligibility({ check: pep, decision: "ACCEPTED", policy, caller: { ...admin, totpVerified: false } }))
      .toEqual({ allowed: false, code: "totp_required" })
    expect(reviewEligibility({
      check: pep, decision: "ACCEPTED",
      policy: { reviewMinRole: "BRANCH_MANAGER", requireStaffTotp: false, requireSecondReviewer: true },
      caller: { id: "m", role: "BRANCH_MANAGER", totpVerified: false },
    })).toEqual({ allowed: true })
  })

  it("refuses a decided check and a check that is not a match", () => {
    expect(reviewEligibility({ check: { ...pep, decision: "ACCEPTED" }, decision: "REJECTED", policy, caller: admin }))
      .toEqual({ allowed: false, code: "already_decided" })
    for (const result of ["CLEAR", "ERROR"] as const) {
      expect(reviewEligibility({ check: { type: "PEP", result, decision: null, triggeredById: null }, decision: "FALSE_POSITIVE", policy, caller: admin }))
        .toEqual({ allowed: false, code: "not_a_match" })
    }
  })
})
