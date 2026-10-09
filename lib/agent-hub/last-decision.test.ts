import { describe, it, expect } from "vitest"
import { parseLastDecision, decisionVerb, formatDecidedAt, formatDecidedLine, type LastDecision } from "./last-decision"

const blocked: LastDecision = {
  commissionStatus: "BLOCKED",
  qualityFlag: "LOW_QUALITY",
  note: "Duplicate referral",
  byEmail: "ops@lender.example",
  at: "2026-08-07T07:14:00.000Z",
}

describe("parseLastDecision", () => {
  it("returns null when nothing decided the row", () => {
    expect(parseLastDecision(null)).toBeNull()
    expect(parseLastDecision(undefined)).toBeNull()
    expect(parseLastDecision({})).toBeNull()
    expect(parseLastDecision({ loanId: "L1" })).toBeNull()
  })

  // metadata is jsonb — it can hold anything, and a decision is a claim that a
  // named person withheld or released money. Garbage is not evidence of one.
  it("returns null for metadata or lastDecision that isn't a plain object", () => {
    expect(parseLastDecision("nonsense")).toBeNull()
    expect(parseLastDecision([])).toBeNull()
    expect(parseLastDecision(42)).toBeNull()
    expect(parseLastDecision({ lastDecision: "nonsense" })).toBeNull()
    expect(parseLastDecision({ lastDecision: [] })).toBeNull()
    expect(parseLastDecision({ lastDecision: null })).toBeNull()
  })

  it("narrows the route's blob to the five display fields", () => {
    expect(parseLastDecision({ reference: "TF-123", lastDecision: { ...blocked, byUserId: "user_1" } })).toEqual(blocked)
  })

  // byUserId is an internal id that says nothing to a reviewer, and this shape
  // crosses to a client component — the loader must never hand over raw metadata.
  it("drops byUserId rather than passing it to the client", () => {
    const parsed = parseLastDecision({ lastDecision: { ...blocked, byUserId: "user_1" } })
    expect(parsed).not.toHaveProperty("byUserId")
  })

  it("nulls non-string and whitespace-only fields instead of rendering them", () => {
    expect(parseLastDecision({ lastDecision: { commissionStatus: 7, note: "   ", byEmail: null, at: {}, qualityFlag: [] } }))
      .toEqual({ commissionStatus: null, qualityFlag: null, note: null, byEmail: null, at: null })
  })

  // The presence of lastDecision IS the fact that someone decided, even if every
  // field inside it is unusable — so this must not collapse back to null.
  it("still reports a decision when the blob is present but empty", () => {
    expect(parseLastDecision({ lastDecision: {} })).not.toBeNull()
  })
})

describe("decisionVerb", () => {
  it("names each terminal decision in the past tense", () => {
    expect(decisionVerb({ ...blocked, commissionStatus: "BLOCKED" })).toBe("Blocked")
    expect(decisionVerb({ ...blocked, commissionStatus: "PAYABLE" })).toBe("Marked payable")
    expect(decisionVerb({ ...blocked, commissionStatus: "REVERSED" })).toBe("Reversed")
  })

  // Review writes commissionStatus back to PENDING with MANUAL_REVIEW, so the
  // status alone cannot tell a review apart from an untouched row.
  it("distinguishes a Review from a bare PENDING by its qualityFlag", () => {
    expect(decisionVerb({ ...blocked, commissionStatus: "PENDING", qualityFlag: "MANUAL_REVIEW" })).toBe("Sent for review")
    expect(decisionVerb({ ...blocked, commissionStatus: "PENDING", qualityFlag: null })).toBe("Decided")
  })

  it("degrades to a neutral verb rather than inventing one", () => {
    expect(decisionVerb({ ...blocked, commissionStatus: null })).toBe("Decided")
    expect(decisionVerb({ ...blocked, commissionStatus: "SOMETHING_NEW" })).toBe("Decided")
  })

  // commissionStatus comes from jsonb, so a plain object lookup would resolve
  // these off Object.prototype and render a function body as the verb.
  it("does not resolve prototype keys as verbs", () => {
    expect(decisionVerb({ ...blocked, commissionStatus: "constructor" })).toBe("Decided")
    expect(decisionVerb({ ...blocked, commissionStatus: "toString" })).toBe("Decided")
    expect(decisionVerb({ ...blocked, commissionStatus: "__proto__" })).toBe("Decided")
  })
})

describe("formatDecidedAt", () => {
  // 07:14 UTC is 09:14 in SAST. Pinning the offset here is the point: a UTC
  // server rendering "07:14" on a South African compliance screen would be a
  // false statement about when someone decided.
  it("renders the instant in SAST, not UTC", () => {
    expect(formatDecidedAt("2026-08-07T07:14:00.000Z")).toBe("07 Aug 09:14")
  })

  it("carries the +2 offset across a date boundary", () => {
    expect(formatDecidedAt("2026-01-03T22:45:00.000Z")).toBe("04 Jan 00:45")
  })

  // `new Date("nonsense").toLocaleDateString()` returns the literal string
  // "Invalid Date"; showing nothing is better than showing that.
  it("returns null for an absent or unparseable timestamp", () => {
    expect(formatDecidedAt(null)).toBeNull()
    expect(formatDecidedAt("")).toBeNull()
    expect(formatDecidedAt("not-a-date")).toBeNull()
  })
})

describe("formatDecidedLine", () => {
  it("reads as a sentence a reviewer can act on", () => {
    expect(formatDecidedLine(blocked)).toBe("Blocked 07 Aug 09:14 by ops@lender.example — Duplicate referral")
  })

  // Every segment after the verb is optional. "Blocked 07 Aug 09:14 by " would
  // imply a missing actor; omitting the segment states only what is known.
  it("omits absent segments rather than leaving dangling connectives", () => {
    expect(formatDecidedLine({ ...blocked, byEmail: null })).toBe("Blocked 07 Aug 09:14 — Duplicate referral")
    expect(formatDecidedLine({ ...blocked, note: null })).toBe("Blocked 07 Aug 09:14 by ops@lender.example")
    expect(formatDecidedLine({ ...blocked, at: null })).toBe("Blocked by ops@lender.example — Duplicate referral")
    expect(formatDecidedLine({ commissionStatus: null, qualityFlag: null, note: null, byEmail: null, at: null })).toBe("Decided")
  })

  it("shows the reason for a payable and a review too", () => {
    expect(formatDecidedLine({ ...blocked, commissionStatus: "PAYABLE", qualityFlag: "APPROVED", note: "Checked — not a duplicate" }))
      .toBe("Marked payable 07 Aug 09:14 by ops@lender.example — Checked — not a duplicate")
    expect(formatDecidedLine({ ...blocked, commissionStatus: "PENDING", qualityFlag: "MANUAL_REVIEW", note: "Awaiting proof of referral" }))
      .toBe("Sent for review 07 Aug 09:14 by ops@lender.example — Awaiting proof of referral")
  })
})
