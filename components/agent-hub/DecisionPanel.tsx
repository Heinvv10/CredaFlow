"use client"

import { useState } from "react"
import { PLACEHOLDER_LABEL, PLACEHOLDER_REASON, REASONS, requiresNote, resolveDecisionNote, type DecisionAction } from "@/lib/agent-hub/decision-reasons"

const ACTION_LABEL: Record<DecisionAction, string> = {
  PAYABLE: "Mark payable",
  BLOCKED: "Block",
  REVIEW: "Review",
}

// Matches CommissionTab's own row-button tones (emerald/red/neutral) so
// confirming a Block doesn't read as a green "success".
const ACTION_TONE: Record<DecisionAction, string> = {
  PAYABLE: "border-emerald-500/30 text-[var(--cf-success)]",
  BLOCKED: "border-red-500/30 text-[var(--cf-danger)]",
  REVIEW: "border-[var(--cf-border-subtle)] text-[var(--cf-text-secondary)]",
}

export function DecisionPanel({ action, presetReason, onCancel, onDone }: {
  action: DecisionAction
  presetReason?: string
  onCancel: () => void
  onDone: (label: string, decisionNote: string) => void
}) {
  const options = REASONS[action]
  // Opened from a SIGNAL's Block/dismiss button, presetReason is an affirmative
  // choice — the reviewer clicked the button sitting next to that signal — so it
  // stays pre-selected. Opened from the row-level buttons there is no preset,
  // and the panel must start on the non-submittable placeholder.
  const [reason, setReason] = useState(presetReason && options.includes(presetReason) ? presetReason : PLACEHOLDER_REASON)
  const [note, setNote] = useState("")

  // Belt-and-braces: if `reason` state ever isn't one of the current action's
  // options (e.g. stale state surviving without a remount), fall back to the
  // placeholder — never to a real reason nobody picked.
  const selectedReason = options.includes(reason) ? reason : PLACEHOLDER_REASON

  // Single source of truth for submittability: the same resolver that builds the
  // note decides whether there is one. "Other" with nothing typed is exactly the
  // canned-string problem this panel exists to remove.
  const resolved = resolveDecisionNote(selectedReason, note)

  return (
    <div className="flex w-64 flex-col gap-2">
      <select
        value={selectedReason}
        onChange={(e) => setReason(e.target.value)}
        aria-label="Decision reason"
        className="rounded border border-[var(--cf-border-strong)] bg-[var(--cf-bg-raised)] px-2 py-1 text-xs text-[var(--cf-text)]"
      >
        <option value={PLACEHOLDER_REASON}>{PLACEHOLDER_LABEL}</option>
        {options.map((option) => <option key={option} value={option}>{option}</option>)}
      </select>
      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        rows={2}
        placeholder={requiresNote(selectedReason) ? "Reason required" : "Optional detail"}
        aria-label="Decision note"
        className="rounded border border-[var(--cf-border-strong)] bg-[var(--cf-bg-raised)] px-2 py-1 text-xs text-[var(--cf-text)]"
      />
      <div className="flex gap-2">
        <button
          type="button"
          disabled={resolved === null}
          onClick={() => resolved !== null && onDone(`${ACTION_LABEL[action]} commission`, resolved)}
          className={`rounded border px-2 py-1 text-xs disabled:opacity-40 ${ACTION_TONE[action]}`}
        >
          Confirm
        </button>
        <button type="button" onClick={onCancel} className="rounded border border-[var(--cf-border-subtle)] px-2 py-1 text-xs text-[var(--cf-text-secondary)]">
          Cancel
        </button>
      </div>
    </div>
  )
}
