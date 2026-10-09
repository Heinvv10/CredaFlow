"use client"

import { filterMentionable, mentionLabel } from "@/lib/inbox/mention-text"

export type MentionableStaff = { id: string; name: string | null; email: string }

// A plain list, deliberately not a Radix popover: Radix primitives cannot be
// driven in this repo's vitest harness, and this needs real tests.
export function MentionPicker(props: {
  staff: MentionableStaff[]
  query: string
  /** The note's author, who is never a useful row — see filterMentionable. */
  excludeUserId?: string
  /** Index of the keyboard-selected row; the composer owns it, this only paints it. */
  activeIndex?: number
  onPick: (s: MentionableStaff) => void
}) {
  // The same helper the composer's keyboard handler uses, so the row Enter picks
  // is the row this list highlighted.
  const matches = filterMentionable(props.staff, props.query, props.excludeUserId)
  if (matches.length === 0) return null
  // Clamped rather than trusted: the filtered list shrinks a keystroke before
  // the composer's index resets, and an out-of-range index would paint nothing.
  const active = Math.min(Math.max(props.activeIndex ?? 0, 0), matches.length - 1)

  // Theme tokens, not bg-white/gray: this repo's UI is dark-first, and a white
  // popover over the dark inbox is a defect the moment it opens. Surface and
  // hover match components/wizard/ClientPicker.tsx, the existing picker
  // dropdown, rather than inventing a palette.
  return (
    <ul role="listbox" className="mb-1 max-h-40 overflow-y-auto rounded-md border border-[var(--cf-border-subtle)] bg-[var(--cf-bg-panel)] text-xs text-[var(--cf-text)] shadow-lg">
      {matches.map((s, i) => (
        // The option role sits on the button, the thing that is actually
        // selectable; the li is presentational so a listbox doesn't claim a
        // structure it doesn't have.
        <li key={s.id} role="presentation">
          <button
            type="button"
            role="option"
            aria-selected={i === active}
            onClick={() => props.onPick(s)}
            // The keyboard-active row gets the same raised surface hover uses,
            // so arrowing and hovering read as the same affordance.
            className={`block w-full px-2 py-1 text-left transition-colors hover:bg-[var(--cf-bg-raised)] ${i === active ? "bg-[var(--cf-bg-raised)]" : ""}`}
          >
            {mentionLabel(s)}
          </button>
        </li>
      ))}
    </ul>
  )
}
