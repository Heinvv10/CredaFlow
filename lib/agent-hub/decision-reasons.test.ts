import { describe, it, expect } from "vitest"
import { REASONS, OTHER_REASON, NO_SIGNAL_APPROVAL_REASON, PLACEHOLDER_REASON, PLACEHOLDER_LABEL, requiresNote, resolveDecisionNote } from "./decision-reasons"

describe("REASONS", () => {
  it("offers presets for all three actions and ends each with Other", () => {
    for (const action of ["PAYABLE", "BLOCKED", "REVIEW"] as const) {
      expect(REASONS[action].length).toBeGreaterThan(1)
      expect(REASONS[action][REASONS[action].length - 1]).toBe(OTHER_REASON)
    }
  })

  // The audit record is the point of this task. A preset that differs between
  // the button and the stored note would make the register unreadable.
  it("has no duplicate presets within an action", () => {
    for (const action of ["PAYABLE", "BLOCKED", "REVIEW"] as const) {
      expect(new Set(REASONS[action]).size).toBe(REASONS[action].length)
    }
  })
})

describe("NO_SIGNAL_APPROVAL_REASON", () => {
  // The owner ruled on this exact wording (2026-08-06) — plain hyphen, not
  // an em dash — after C1 found the one-click "Mark payable" path (no
  // signals) submitting REASONS.PAYABLE[0], which falsely claims a
  // duplicate check was performed.
  it("matches the owner-approved wording exactly", () => {
    expect(NO_SIGNAL_APPROVAL_REASON).toBe("Approved from the commission queue - no triage signals raised")
  })

  // Must never be pickable from the panel's dropdown in place of a real
  // signal-based reason — it exists only for the no-signal one-click path.
  it("is not a member of REASONS.PAYABLE", () => {
    expect(REASONS.PAYABLE).not.toContain(NO_SIGNAL_APPROVAL_REASON)
  })
})

// DecisionPanel is a React component and this suite runs environment: "node"
// with no jsdom, so the panel itself cannot be mounted here. What CAN be pinned
// is the seam the panel's `disabled={resolved === null}` reads: if
// resolveDecisionNote ever accepted PLACEHOLDER_REASON, Confirm would enable on
// mount again and two clicks would record a reason nobody picked.
describe("PLACEHOLDER_REASON", () => {
  it("is not submittable, with or without a typed note", () => {
    expect(resolveDecisionNote(PLACEHOLDER_REASON, "")).toBeNull()
    expect(resolveDecisionNote(PLACEHOLDER_REASON, "   ")).toBeNull()
    // A typed note must not rescue it: the note explains the reason, it is not
    // a substitute for choosing one.
    expect(resolveDecisionNote(PLACEHOLDER_REASON, "agent called to confirm")).toBeNull()
  })

  // If the placeholder were ever given a real value it would become a pickable
  // option that resolves to a note — the exact vacuous-reason defect it exists
  // to close.
  it("carries no submittable value and is not one of the presets", () => {
    expect(PLACEHOLDER_REASON).toBe("")
    for (const action of ["PAYABLE", "BLOCKED", "REVIEW"] as const) {
      expect(REASONS[action]).not.toContain(PLACEHOLDER_REASON)
      expect(REASONS[action]).not.toContain(PLACEHOLDER_LABEL)
    }
  })

  it("has a label that reads as an instruction, not a reason", () => {
    expect(PLACEHOLDER_LABEL).toBe("— select a reason —")
  })
})

describe("requiresNote", () => {
  it("requires a note only for Other", () => {
    expect(requiresNote(OTHER_REASON)).toBe(true)
    expect(requiresNote("Duplicate referral")).toBe(false)
  })
})

describe("resolveDecisionNote", () => {
  it("sends the preset alone when no note is typed", () => {
    expect(resolveDecisionNote("Duplicate referral", "")).toBe("Duplicate referral")
  })

  it("appends a typed note to the preset", () => {
    expect(resolveDecisionNote("Duplicate referral", "same loan as LN-1")).toBe("Duplicate referral — same loan as LN-1")
  })

  // "Other" with nothing typed is exactly the canned-string problem this task exists
  // to remove, so it must not be submittable.
  it("refuses Other with no note", () => {
    expect(resolveDecisionNote(OTHER_REASON, "   ")).toBeNull()
  })

  it("sends only the typed text for Other", () => {
    expect(resolveDecisionNote(OTHER_REASON, "agent called to confirm")).toBe("agent called to confirm")
  })

  it("refuses an empty reason", () => {
    expect(resolveDecisionNote("", "anything")).toBeNull()
  })

  it("trims and caps at the route's 500-char limit", () => {
    const long = "x".repeat(600)
    expect(resolveDecisionNote(OTHER_REASON, long)!.length).toBe(500)
  })

  // The preset+note path (a non-Other reason with a typed note) hits a
  // different return statement than the Other path above — cap it
  // separately, and confirm the cap doesn't cut from the wrong end.
  it("caps the preset+note path at 500 chars too", () => {
    const long = "x".repeat(600)
    const result = resolveDecisionNote("Duplicate referral", long)!
    expect(result.length).toBe(500)
    expect(result.startsWith("Duplicate referral — ")).toBe(true)
  })
})
