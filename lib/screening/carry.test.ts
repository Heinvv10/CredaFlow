import { describe, expect, it } from "vitest"
import { carriedDecision, carryableMatches, matchFingerprint, type PriorDecision } from "./carry"

const m = (listEntryId: string, listVersion: string | null = null) => ({ listEntryId, listVersion, listName: "L", matchedName: "N", score: 90, detail: null })
const now = new Date("2026-10-14T10:00:00Z")
const prior = (over: Partial<PriorDecision>): PriorDecision => ({
  id: "p1", type: "PEP", result: "POSSIBLE_MATCH", matchFingerprint: matchFingerprint("PEP", "POSSIBLE_MATCH", [m("a")]),
  subjectFingerprint: "identity-1", decision: "FALSE_POSITIVE", decisionReason: "reason", reviewedById: "rev", reviewedAt: new Date("2026-06-01T00:00:00Z"),
  carriedFromCheckId: null, createdAt: new Date("2026-06-01T00:00:00Z"), ...over,
})
const candidate = (over: Partial<Parameters<typeof carriedDecision>[0]> = {}) => ({
  type: "PEP" as const, result: "POSSIBLE_MATCH" as const, matches: [m("a")],
  fingerprint: matchFingerprint("PEP", "POSSIBLE_MATCH", [m("a")]), subjectFingerprint: "identity-1", ...over,
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

describe("matchFingerprint (round 2)", () => {
  it("LOW: differs when the matched name or score of the same entry changes", () => {
    const base = matchFingerprint("PEP", "POSSIBLE_MATCH", [m("a")])
    expect(matchFingerprint("PEP", "POSSIBLE_MATCH", [{ ...m("a"), matchedName: "Other" }])).not.toBe(base)
    expect(matchFingerprint("PEP", "POSSIBLE_MATCH", [{ ...m("a"), score: 91 }])).not.toBe(base)
  })

  it("is unambiguous: separators inside a field cannot make two entry sets collide", () => {
    expect(matchFingerprint("PEP", "POSSIBLE_MATCH", [m("a@b", null)])).not.toBe(matchFingerprint("PEP", "POSSIBLE_MATCH", [m("a", "b")]))
  })
})

describe("carriedDecision", () => {
  it("N2: never carries a clearance made for a different identity of the subject", () => {
    expect(carriedDecision(candidate({ subjectFingerprint: "identity-2" }), [prior({})], opts)).toBeNull()
  })

  it("carries a recent clearance of the same possible match by a still-eligible reviewer", () => {
    expect(carriedDecision(candidate(), [prior({})], opts)?.prior.id).toBe("p1")
  })

  it("policy: carries a clearance of a confirmed PEP or adverse-media match onto an identical confirmed match", () => {
    for (const type of ["PEP", "ADVERSE_MEDIA"] as const) {
      const fp = matchFingerprint(type, "CONFIRMED_MATCH", [m("a")])
      const confirmed = candidate({ type, result: "CONFIRMED_MATCH", fingerprint: fp })
      expect(carriedDecision(confirmed, [prior({ type, result: "CONFIRMED_MATCH", matchFingerprint: fp, decision: "ACCEPTED" })], opts)?.prior.id, type).toBe("p1")
    }
  })

  it("M1: never carries upward — a POSSIBLE_MATCH decision onto a CONFIRMED_MATCH of the same entry — nor downward", () => {
    const fpConfirmed = matchFingerprint("PEP", "CONFIRMED_MATCH", [m("a")])
    const escalated = candidate({ result: "CONFIRMED_MATCH", fingerprint: fpConfirmed })
    expect(carriedDecision(escalated, [prior({ result: "POSSIBLE_MATCH", matchFingerprint: fpConfirmed })], opts)).toBeNull()
    expect(carriedDecision(escalated, [prior({})], opts)).toBeNull()
    expect(carriedDecision(candidate(), [prior({ result: "CONFIRMED_MATCH" })], opts)).toBeNull()
  })

  it("never carries for SANCTIONS, at any level", () => {
    for (const result of ["POSSIBLE_MATCH", "CONFIRMED_MATCH"] as const) {
      const fp = matchFingerprint("SANCTIONS", result, [m("a")])
      expect(carriedDecision(
        candidate({ type: "SANCTIONS", result, fingerprint: fp }),
        [prior({ type: "SANCTIONS", result, matchFingerprint: fp })],
        opts,
      ), result).toBeNull()
    }
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
