export type DecisionAction = "PAYABLE" | "BLOCKED" | "REVIEW"

export const OTHER_REASON = "Other"

// The one-click "Mark payable" path on a row with no triage signals — no
// preset was chosen, no duplicate check was performed. Deliberately kept
// OUT of REASONS.PAYABLE below: it must never be an option a reviewer can
// pick from the panel's dropdown in place of a real signal-based reason.
export const NO_SIGNAL_APPROVAL_REASON = "Approved from the commission queue - no triage signals raised"

// Preset wording is the audit vocabulary: it lands verbatim in
// AuditLog.newValue.decisionNote, so it must read as a reason a regulator or a
// disputing agent could understand without this codebase in front of them.
export const REASONS: Record<DecisionAction, readonly string[]> = {
  PAYABLE: [
    "Checked — not a duplicate",
    "Checked — agent relationship is legitimate",
    OTHER_REASON,
  ],
  BLOCKED: [
    "Duplicate referral",
    "Agent not eligible",
    "Referral not genuine / no evidence",
    "Borrower disputes referral",
    OTHER_REASON,
  ],
  REVIEW: [
    "Awaiting proof of referral",
    "Verifying agent relationship",
    "Borrower and agent share contact details",
    "Possible duplicate",
    OTHER_REASON,
  ],
}

// The DecisionPanel's first <option>. Its value is the empty string precisely
// so resolveDecisionNote() below refuses it, leaving Confirm disabled until the
// reviewer actively picks: pre-selecting REASONS[action][0] meant two clicks
// recorded "Duplicate referral" — a substantive factual claim about a named
// agent — that no human ever chose.
export const PLACEHOLDER_REASON = ""
export const PLACEHOLDER_LABEL = "— select a reason —"

export function requiresNote(reason: string): boolean {
  return reason === OTHER_REASON
}

/** The route caps decisionNote at 500 chars; cap here too so the UI cannot
 *  silently submit text that gets truncated server-side. */
const MAX_NOTE = 500

export function resolveDecisionNote(reason: string, note: string): string | null {
  const trimmedReason = reason.trim()
  const trimmedNote = note.trim()
  if (!trimmedReason) return null
  if (requiresNote(trimmedReason)) {
    return trimmedNote ? trimmedNote.slice(0, MAX_NOTE) : null
  }
  const combined = trimmedNote ? `${trimmedReason} — ${trimmedNote}` : trimmedReason
  return combined.slice(0, MAX_NOTE)
}
