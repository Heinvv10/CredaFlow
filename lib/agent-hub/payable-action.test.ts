import { describe, it, expect } from "vitest"
import { payableActionFor } from "./payable-action"
import { NO_SIGNAL_APPROVAL_REASON } from "./decision-reasons"
import type { TriageSignal } from "./triage-signals"

const signal: TriageSignal = {
  kind: "REPEAT_BORROWER_SAME_AGENT",
  severity: "medium",
  message: "Referred 2× by this agent",
  blockReason: "Duplicate referral",
  dismissReason: "Checked — not a duplicate",
}

describe("payableActionFor", () => {
  // THE regression this file exists for. The row-level Mark payable button
  // used to pass `presetReason: event.signals[0].dismissReason`, which
  // DecisionPanel accepted (it is a member of REASONS.PAYABLE), so Confirm was
  // enabled on mount and two clicks wrote "Checked — agent relationship is
  // legitimate" — a claim that a human performed a check — that nobody chose.
  // It survived one full review round. toEqual is exact: any preset added back
  // to the panel branch fails here.
  it("opens the panel carrying NO preset reason when the row raised a signal", () => {
    expect(payableActionFor("evt_1", [signal])).toEqual({ kind: "panel", decision: { eventId: "evt_1", action: "PAYABLE" } })
  })

  it("carries no preset however many signals the row raised", () => {
    const second: TriageSignal = { ...signal, kind: "AGENT_SHARES_PHONE", severity: "high" }
    for (const signals of [[signal], [second], [second, signal]]) {
      const action = payableActionFor("evt_1", signals)
      expect(action.kind).toBe("panel")
      expect(Object.keys(action)).toEqual(["kind", "decision"])
      // The payload the component hands straight to setDecision. Pinning its
      // exact key set is what makes a re-added preset fail: the regression was
      // an inline literal in the JSX, so the assertion has to bite on the
      // object the helper now owns, not merely on the branch marker.
      expect(action.kind === "panel" && Object.keys(action.decision)).toEqual(["eventId", "action"])
      expect(action).not.toHaveProperty("decision.presetReason")
    }
  })

  it("addresses the payload to the row that was clicked", () => {
    const action = payableActionFor("evt_other", [signal])
    expect(action.kind === "panel" && action.decision.eventId).toBe("evt_other")
  })

  // A clean row keeps its one click, and the note it records says exactly that
  // and nothing more — never a duplicate-check claim (NO_SIGNAL_APPROVAL_REASON
  // is deliberately not a member of REASONS.PAYABLE; see decision-reasons.test.ts).
  it("stays one click on a row with no signals, with the no-signal note", () => {
    expect(payableActionFor("evt_1", [])).toEqual({ kind: "one-click", decisionNote: NO_SIGNAL_APPROVAL_REASON })
  })

  it("uses the owner-approved wording verbatim, not a paraphrase", () => {
    const action = payableActionFor("evt_1", [])
    expect(action.kind === "one-click" && action.decisionNote).toBe("Approved from the commission queue - no triage signals raised")
  })
})
