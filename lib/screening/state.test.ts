import { describe, expect, it } from "vitest"
import {
  amlStatusFor,
  carriedDecision,
  deriveScreeningState,
  matchFingerprint,
  reviewEligibility,
  screeningAllowsApproval,
  type ScreeningCheckFacts,
} from "./state"

const clear = (type: ScreeningCheckFacts["type"], id = `c-${type}`): ScreeningCheckFacts =>
  ({ id, type, result: "CLEAR", decision: null, simulated: false })
const run = (...over: ScreeningCheckFacts[]): ScreeningCheckFacts[] =>
  (["PEP", "SANCTIONS", "ADVERSE_MEDIA"] as const).map((t) => over.find((o) => o.type === t) ?? clear(t))
const derive = (latestRun: ScreeningCheckFacts[], simulationPermitted = true) =>
  deriveScreeningState({ configured: true, latestRun, simulationPermitted })

describe("deriveScreeningState", () => {
  it("is NOT_CONFIGURED without a provider, which allows approval and writes nothing", () => {
    const s = deriveScreeningState({ configured: false, latestRun: [], simulationPermitted: false })
    expect(s.state).toBe("NOT_CONFIGURED")
    expect(screeningAllowsApproval(s)).toBe(true)
    expect(amlStatusFor(s)).toBeNull()
  })

  it("blocks a configured lender's client who was never screened", () => {
    const s = derive([])
    expect(s.state).toBe("NOT_SCREENED")
    expect(screeningAllowsApproval(s)).toBe(false)
    expect(amlStatusFor(s)).toBe("PENDING")
  })

  it("is CLEAR when every type is clear", () => {
    const s = derive(run())
    expect(s.state).toBe("CLEAR")
    expect(screeningAllowsApproval(s)).toBe(true)
    expect(amlStatusFor(s)).toBe("CLEARED")
  })

  it("refers an undecided PEP match and blocks approval until it is decided", () => {
    const pep: ScreeningCheckFacts = { id: "pep", type: "PEP", result: "CONFIRMED_MATCH", decision: null, simulated: false }
    const s = derive(run(pep))
    expect(s).toEqual({ state: "REFER", checkIds: ["pep"] })
    expect(screeningAllowsApproval(s)).toBe(false)
    expect(amlStatusFor(s)).toBe("FLAGGED")
  })

  it("clears once the PEP match is ACCEPTED or found a FALSE_POSITIVE", () => {
    for (const decision of ["ACCEPTED", "FALSE_POSITIVE"] as const) {
      const s = derive(run({ id: "pep", type: "PEP", result: "CONFIRMED_MATCH", decision, simulated: false }))
      expect(s.state, decision).toBe("CLEAR")
    }
  })

  it("refers a possible match too", () => {
    const s = derive(run({ id: "p", type: "SANCTIONS", result: "POSSIBLE_MATCH", decision: null, simulated: false }))
    expect(s.state).toBe("REFER")
  })

  it("hard-blocks a confirmed sanctions match, even beside other decided matches", () => {
    const s = derive(run(
      { id: "s", type: "SANCTIONS", result: "CONFIRMED_MATCH", decision: null, simulated: false },
      { id: "pep", type: "PEP", result: "CONFIRMED_MATCH", decision: "ACCEPTED", simulated: false },
    ))
    expect(s).toEqual({ state: "BLOCKED", reason: "SANCTIONS_MATCH", checkIds: ["s"] })
    expect(screeningAllowsApproval(s)).toBe(false)
  })

  it("hard-blocks a REJECTED match", () => {
    const s = derive(run({ id: "m", type: "ADVERSE_MEDIA", result: "CONFIRMED_MATCH", decision: "REJECTED", simulated: false }))
    expect(s).toMatchObject({ state: "BLOCKED", reason: "REJECTED" })
  })

  it("is INCOMPLETE on a provider error or a missing type, which blocks", () => {
    const errored = derive(run({ id: "e", type: "PEP", result: "ERROR", decision: null, simulated: false }))
    expect(errored).toEqual({ state: "INCOMPLETE", checkIds: ["e"] })
    const missing = derive([clear("PEP"), clear("SANCTIONS")])
    expect(missing.state).toBe("INCOMPLETE")
    expect(screeningAllowsApproval(missing)).toBe(false)
  })

  it("does not accept a simulated clear where simulation is forbidden", () => {
    const sim = run().map((c) => ({ ...c, simulated: true }))
    expect(derive(sim, true).state).toBe("CLEAR")
    const s = derive(sim, false)
    expect(s).toMatchObject({ state: "BLOCKED", reason: "SIMULATED_NOT_PERMITTED" })
    expect(screeningAllowsApproval(s)).toBe(false)
  })
})

describe("reviewEligibility", () => {
  const policy = { reviewMinRole: "ADMIN" as const, requireStaffTotp: true }
  const admin = { role: "ADMIN" as const, totpVerified: true }
  const pep = { type: "PEP" as const, result: "CONFIRMED_MATCH" as const, decision: null }

  it("lets a senior with 2FA decide a PEP match", () => {
    for (const decision of ["ACCEPTED", "FALSE_POSITIVE", "REJECTED"] as const) {
      expect(reviewEligibility({ check: pep, decision, policy, caller: admin })).toEqual({ allowed: true })
    }
  })

  it("never clears a confirmed sanctions match, whoever asks and whatever the decision", () => {
    const check = { type: "SANCTIONS" as const, result: "CONFIRMED_MATCH" as const, decision: null }
    for (const decision of ["ACCEPTED", "FALSE_POSITIVE", "REJECTED"] as const) {
      expect(reviewEligibility({ check, decision, policy, caller: { role: "SUPER_ADMIN", totpVerified: true } }))
        .toEqual({ allowed: false, code: "sanctions_not_clearable" })
    }
  })

  it("never ACCEPTS a possible sanctions match, but allows a false positive", () => {
    const check = { type: "SANCTIONS" as const, result: "POSSIBLE_MATCH" as const, decision: null }
    expect(reviewEligibility({ check, decision: "ACCEPTED", policy, caller: admin }))
      .toEqual({ allowed: false, code: "sanctions_not_acceptable" })
    expect(reviewEligibility({ check, decision: "FALSE_POSITIVE", policy, caller: admin })).toEqual({ allowed: true })
  })

  it("refuses a role below the lender's minimum, and missing 2FA when the lender requires it", () => {
    expect(reviewEligibility({ check: pep, decision: "ACCEPTED", policy, caller: { role: "BRANCH_MANAGER", totpVerified: true } }))
      .toEqual({ allowed: false, code: "role_below_policy" })
    expect(reviewEligibility({ check: pep, decision: "ACCEPTED", policy, caller: { role: "ADMIN", totpVerified: false } }))
      .toEqual({ allowed: false, code: "totp_required" })
    expect(reviewEligibility({
      check: pep, decision: "ACCEPTED",
      policy: { reviewMinRole: "BRANCH_MANAGER", requireStaffTotp: false },
      caller: { role: "BRANCH_MANAGER", totpVerified: false },
    })).toEqual({ allowed: true })
  })

  it("refuses a decided check and a check that is not a match", () => {
    expect(reviewEligibility({ check: { ...pep, decision: "ACCEPTED" }, decision: "REJECTED", policy, caller: admin }))
      .toEqual({ allowed: false, code: "already_decided" })
    for (const result of ["CLEAR", "ERROR"] as const) {
      expect(reviewEligibility({ check: { type: "PEP", result, decision: null }, decision: "FALSE_POSITIVE", policy, caller: admin }))
        .toEqual({ allowed: false, code: "not_a_match" })
    }
  })
})

describe("carry-forward", () => {
  const m = (listEntryId: string) => ({ listEntryId, listName: "L", matchedName: "N", score: 90, detail: null })

  it("fingerprints the same entries the same, in any order, and different entries differently", () => {
    expect(matchFingerprint("PEP", [m("a"), m("b")])).toBe(matchFingerprint("PEP", [m("b"), m("a"), m("a")]))
    expect(matchFingerprint("PEP", [m("a")])).not.toBe(matchFingerprint("PEP", [m("a"), m("b")]))
    expect(matchFingerprint("PEP", [m("a")])).not.toBe(matchFingerprint("ADVERSE_MEDIA", [m("a")]))
  })

  it("carries the newest decision for the same type and fingerprint, and nothing for new evidence", () => {
    const fp = matchFingerprint("PEP", [m("a")])
    const priors = [
      { id: "old", type: "PEP" as const, matchFingerprint: fp, decision: "FALSE_POSITIVE" as const, decisionReason: "r", createdAt: new Date("2026-01-01") },
      { id: "new", type: "PEP" as const, matchFingerprint: fp, decision: "ACCEPTED" as const, decisionReason: "r", createdAt: new Date("2026-06-01") },
      { id: "undecided", type: "PEP" as const, matchFingerprint: fp, decision: null, decisionReason: null, createdAt: new Date("2026-09-01") },
    ]
    expect(carriedDecision({ type: "PEP", fingerprint: fp }, priors)?.id).toBe("new")
    expect(carriedDecision({ type: "PEP", fingerprint: matchFingerprint("PEP", [m("b")]) }, priors)).toBeNull()
  })
})
