import { NO_SIGNAL_APPROVAL_REASON } from "./decision-reasons"
import type { TriageSignal } from "./triage-signals"

/**
 * What the ROW-LEVEL "Mark payable" button does for a given row.
 *
 * `panel` carries the WHOLE `setDecision` payload, not just a marker, so the
 * component has no object literal left to hand-assemble. That is deliberate:
 * the original defect was never a return value, it was
 * `setDecision({ eventId, action: "PAYABLE", presetReason: signals[0].dismissReason })`
 * written inline in the JSX — and because `presetReason` is an optional member
 * of the component's own `Decision` type, re-adding it there compiled cleanly
 * and passed every test. Moving the payload here closes that: the only place a
 * preset can now be added is this file, where it is both a compile error
 * (excess-property check against the closed `decision` type) and a test failure.
 *
 * The button sits in the Decide column with no signal adjacent to it, so a
 * preset is a substantive claim about a named agent that the reviewer never
 * chose — it left `Confirm` enabled on mount and put a two-click
 * "Checked — agent relationship is legitimate" into the audit log.
 *
 * NOT to be confused with the per-signal Block / "Looks fine" buttons, which
 * build their own payloads WITH a preset. Clicking one of those IS an
 * affirmative choice about that specific signal, and they are correct as they are.
 */
export type PayableAction =
  | { kind: "panel"; decision: { eventId: string; action: "PAYABLE" } }
  | { kind: "one-click"; decisionNote: string }

/**
 * A signalled row must go through the panel so the reviewer states a reason:
 * approving over a signal is exactly the decision worth recording. Only a row
 * that raised nothing may be approved in one click, and then the note says so
 * and nothing more.
 */
export function payableActionFor(eventId: string, signals: TriageSignal[]): PayableAction {
  if (signals.length > 0) return { kind: "panel", decision: { eventId, action: "PAYABLE" } }
  return { kind: "one-click", decisionNote: NO_SIGNAL_APPROVAL_REASON }
}
