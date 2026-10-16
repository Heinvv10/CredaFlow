"use client"

import { Textarea } from "@/components/ui/textarea"
import { DECLINE_CLIENT_REASONS, parseDeclineCategory } from "@/lib/applications/decline-category"
import { DeclineCategorySelect } from "./DeclineCategorySelect"

export interface DeclineDraft {
  category: string
  /** What the client is shown (portal and the decline email). */
  clientReason: string
  /** Staff-only; never shown to the client. */
  internalNote: string
}

export const EMPTY_DECLINE: DeclineDraft = { category: "", clientReason: "", internalNote: "" }

/**
 * A new category replaces the client reason only while it is still the
 * previous category's text (or empty): wording staff wrote themselves is kept.
 */
export function withCategory(draft: DeclineDraft, category: string): DeclineDraft {
  const previous = parseDeclineCategory(draft.category)
  const untouched = draft.clientReason.trim() === ""
    || (previous !== null && draft.clientReason === DECLINE_CLIENT_REASONS[previous])
  const next = parseDeclineCategory(category)
  return {
    ...draft,
    category,
    clientReason: untouched ? (next ? DECLINE_CLIENT_REASONS[next] : "") : draft.clientReason,
  }
}

export function declineDraftComplete(draft: DeclineDraft): boolean {
  return parseDeclineCategory(draft.category) !== null && draft.clientReason.trim() !== ""
}

/** The decline form's fields: category, the client's reason, the staff-only note. */
export function DeclineFields({ draft, onChange, disabled }: {
  draft: DeclineDraft
  onChange: (draft: DeclineDraft) => void
  disabled?: boolean
}) {
  return (
    <div className="flex w-full flex-col gap-2">
      <DeclineCategorySelect value={draft.category} onChange={(category) => onChange(withCategory(draft, category))} disabled={disabled} />
      <label className="w-full text-sm text-[var(--cf-text-secondary)]">
        Reason shown to the client (required)
        <Textarea
          aria-label="Reason shown to the client"
          value={draft.clientReason}
          onChange={(e) => onChange({ ...draft, clientReason: e.target.value })}
          placeholder="Choose a category to start from its wording, then edit if needed."
          rows={3}
          disabled={disabled}
          className="mt-1 w-full"
        />
        <span className="mt-0.5 block text-xs text-[var(--cf-text-muted)]">
          Shown to the client in the portal and in the decline email.
        </span>
      </label>
      <label className="w-full text-sm text-[var(--cf-text-secondary)]">
        Internal note (staff only, never shown to the client)
        <Textarea
          aria-label="Internal note"
          value={draft.internalNote}
          onChange={(e) => onChange({ ...draft, internalNote: e.target.value })}
          rows={2}
          disabled={disabled}
          className="mt-1 w-full"
        />
      </label>
    </div>
  )
}
