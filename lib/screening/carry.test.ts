import { describe, expect, it } from "vitest"
import { carriedDecision, carryableMatches, matchFingerprint, type PriorDecision } from "./carry"

const m = (listEntryId: string, listVersion: string | null = null) => ({ listEntryId, listVersion, listName: "L", matchedName: "N", score: 90, detail: null })
const now = new Date("2026-10-14T10:00:00Z")
const prior = (over: Partial<PriorDecision>): PriorDecision => ({
  id: "p1", type: "PEP", result: "POSSIBLE_MATCH", matchFingerprint: matchFingerprint("PEP", "POSSIBLE_MATCH", [m("a")]),
  decision: "FALSE_POSITIVE", decisionReason: "reason", reviewedById: "rev", reviewedAt: new Date("2026-06-01T00:00:00Z"),
  carriedFromCheckId: null, createdAt: new Date("2026-06-01T00:00:00Z"), ...over,
})
const candidate = (over: Partial<Parameters<typeof carriedDecision>[0]> = {}) => ({
  type: "PEP" as const, result: "POSSIBLE_MATCH" as const, matches: [m("a")],
  fingerprint: matchFingerprint("PEP", "POSSIBLE_MATCH", [m("a")]), ...over,
})
const opts = { now, reviewerEligible: () => true }

describe("matchFingerprint", () => {
  it("is order- and duplicate-insensitive, and differs by entry, type, result and list version", () => {
    expect(matchFingerprint("PEP", "POSSIBLE_MATCH", [m("a"), m("b")])).toBe(matchFingerprint("PEP", "POSSIBLE_MATCH", [m("b"), m("a"), m("a")]))
    const base = matchFingerprint("PEP", "POSSIBLE_MATCH", [m("a")])
    expect(matchFingerprint("PEP", "POSSIBLE_MATCH", [m("a"), m("b")])).not.toBe(base)
    expect(matchFingerprint("ADVERSE_MEDIA", "POSSIBLE_MATCH", [m("a")])).not.toBe(base)
    expect(matchFingerprint("PEP", "CONFIRMED_MATCH", [m("a")])).not.toBe(base)
    expect(matchFingerprint("PEP", "POSSIBLE_MATCH", [m("a", "v2")])).not.toBe(base)
  })
})

describe("carriedDecision", () => {
  it("carries a recent clearance of the same possible match by a still-eligible reviewer", () => {
    expect(carriedDecision(candidate(), [prior({})], opts)?.prior.id).toBe("p1")
  })

  it("M1: never carries onto a CONFIRMED_MATCH, nor from one", () => {
    const fp = matchFingerprint("PEP", "CONFIRMED_MATCH", [m("a")])
    expect(carriedDecision(candidate({ result: "CONFIRMED_MATCH", fingerprint: fp }), [prior({ result: "CONFIRMED_MATCH", matchFingerprint: fp })], opts)).toBeNull()
    expect(carriedDecision(candidate(), [prior({ result: "CONFIRMED_MATCH" })], opts)).toBeNull()
  })

  it("M2: never carries when there are no matches or an entry lacks its id", () => {
    expect(carryableMatches([])).toBe(false)
    expect(carryableMatches([m("a"), m(" ")])).toBe(false)
    const empty = matchFingerprint("PEP", "POSSIBLE_MATCH", [])
    expect(carriedDecision(candidate({ matches: [], fingerprint: empty }), [prior({ matchFingerprint: empty })], opts)).toBeNull()
    const blank = matchFingerprint("PEP", "POSSIBLE_MATCH", [m("")])
    expect(carriedDecision(candidate({ matches: [m("")], fingerprint: blank }), [prior({ matchFingerprint: blank })], opts)).toBeNull()
  })

  it("never carries REJECTED (a sticky block does the work) or new evidence", () => {
    expect(carriedDecision(candidate(), [prior({ decision: "REJECTED" })], opts)).toBeNull()
    expect(carriedDecision(candidate(), [prior({ matchFingerprint: "other" })], opts)).toBeNull()
  })

  it("A3: never carries a clearance older than the reuse limit, measured from the human decision", () => {
    const old = prior({ id: "root", reviewedAt: new Date("2025-09-01T00:00:00Z"), createdAt: new Date("2025-09-01T00:00:00Z") })
    const recentCarry = prior({ id: "carry", reviewedById: null, reviewedAt: new Date("2026-10-01T00:00:00Z"), carriedFromCheckId: "root", createdAt: new Date("2026-10-01T00:00:00Z") })
    expect(carriedDecision(candidate(), [old, recentCarry], opts)).toBeNull()
  })

  it("LOW: never carries when the original reviewer no longer meets the minimum role", () => {
    expect(carriedDecision(candidate(), [prior({})], { now, reviewerEligible: (id) => id !== "rev" })).toBeNull()
  })

  it("follows a carry chain to the human decision", () => {
    const root = prior({ id: "root" })
    const carry = prior({ id: "carry", reviewedById: null, carriedFromCheckId: "root", createdAt: new Date("2026-09-01T00:00:00Z") })
    expect(carriedDecision(candidate(), [root, carry], opts)).toMatchObject({ prior: { id: "carry" }, root: { id: "root" } })
  })
})
