"use client"

import { useEffect, useState } from "react"
import type { MentionableStaff } from "@/components/comms/MentionPicker"
import { activeMentionQuery, filterMentionable, mentionLabel } from "./mention-text"
import { loadMentionableStaff } from "./mentionable-staff"

/**
 * Everything a textarea needs to drive the mention picker: the open run, the
 * roster, the keyboard-selected row, and the two handlers.
 *
 * Extracted from the composer so the inline note EDITOR can have the identical
 * behaviour without a second copy of it. A previous round on this feature
 * shipped exactly that bug in miniature — the picker filtered the author out
 * while the composer's own list did not, so the visible rows were right and the
 * id sent to the server was wrong. One implementation, two callers.
 *
 * What stays with the CALLER, deliberately: the text itself and the list of
 * picked mentions. The composer keeps both per conversation (they survive a
 * thread switch) and the bubble keeps them per edit session, and neither shape
 * belongs in here.
 */
export type MentionPicking = {
  /** Non-null when a mention query is open; render the picker only then. */
  openRun: { at: number; query: string } | null
  /** The roster, for the picker to filter and render. */
  staff: MentionableStaff[]
  /** Index of the keyboard-selected row in the FILTERED list. */
  activeRow: number
  /** Call with every textarea change, before storing the new text. */
  handleChange: (value: string, caret: number) => void
  /** Escape / ArrowUp / ArrowDown / Enter, only while a run is open. */
  handleKeyDown: (e: { key: string; preventDefault: () => void }) => void
  /** Picks a row — the picker's onPick. */
  pick: (s: MentionableStaff) => void
}

export function useMentionPicker(opts: {
  /** Mentions only exist on internal notes, so a reply never opens the picker. */
  enabled: boolean
  /**
   * Identifies the textarea the caret and the Escape dismissal belong to (the
   * conversation, or the note being edited). A caret left over from another one
   * must not be used to derive this one's mention query.
   */
  scopeKey: string
  text: string
  /**
   * The signed-in staffer, left out of the rows: a self-mention is discarded
   * server-side, so picking it tags nobody.
   */
  currentUserId?: string
  /** Receives the text with the run replaced, plus the row that was picked. */
  onPick: (nextText: string, picked: MentionableStaff) => void
}): MentionPicking {
  const [staff, setStaff] = useState<MentionableStaff[]>([])
  const [caret, setCaret] = useState<{ scopeKey: string; caret: number } | null>(null)
  const activeCaret = caret?.scopeKey === opts.scopeKey ? caret.caret : opts.text.length
  const mentionRun = opts.enabled ? activeMentionQuery(opts.text, activeCaret) : null
  // Escape is scoped to the run it dismissed, not to the textarea: closing the
  // picker must not stop the NEXT `@` from opening one. Cleared in handleChange
  // as soon as the run moves or closes.
  const [dismissedRun, setDismissedRun] = useState<{ scopeKey: string; at: number } | null>(null)
  const openRun =
    mentionRun !== null && dismissedRun?.scopeKey === opts.scopeKey && dismissedRun.at === mentionRun.at
      ? null
      : mentionRun
  const mentionQueryOpen = openRun !== null
  // Keyboard selection. This level owns the index because Enter has to act on
  // the filtered list, and only here are both the roster and the run in scope.
  const [activeIndex, setActiveIndex] = useState(0)
  const matches = openRun === null ? [] : filterMentionable(staff, openRun.query, opts.currentUserId)
  const activeRow = matches.length === 0 ? -1 : Math.min(activeIndex, matches.length - 1)
  const activeMention = activeRow === -1 ? null : matches[activeRow]

  // Fetched on the first `@` rather than on mount: most mounts never type one,
  // and the list is only needed once a query is actually open.
  useEffect(() => {
    if (!mentionQueryOpen) return
    let active = true
    void loadMentionableStaff().then((list) => { if (active) setStaff(list) })
    return () => { active = false }
  }, [mentionQueryOpen])

  // Replaces the open "@run" with the label the picker showed, in place. The
  // label is what the stale-mention filter later matches on, so it has to be
  // the same string the row rendered — hence the shared mentionLabel, not a
  // second `name ?? email`.
  function pick(s: MentionableStaff) {
    if (openRun === null) return
    const inserted = `@${mentionLabel(s)} `
    setCaret({ scopeKey: opts.scopeKey, caret: openRun.at + inserted.length })
    setActiveIndex(0)
    opts.onPick(`${opts.text.slice(0, openRun.at)}${inserted}${opts.text.slice(activeCaret)}`, s)
  }

  return {
    openRun,
    staff,
    activeRow,
    pick,
    handleChange(value: string, caretAt: number) {
      setCaret({ scopeKey: opts.scopeKey, caret: caretAt })
      // A keystroke changes which rows match, so an index carried over from the
      // previous query would point at a different person.
      setActiveIndex(0)
      const nextRun = opts.enabled ? activeMentionQuery(value, caretAt) : null
      if (nextRun === null || nextRun.at !== dismissedRun?.at) setDismissedRun(null)
    },
    handleKeyDown(e: { key: string; preventDefault: () => void }) {
      if (openRun === null) return
      // Ahead of the match check: Escape dismisses the open RUN, and a run with
      // no matching row is still open — gating it behind a match made Escape a
      // no-op exactly when nothing was rendered.
      if (e.key === "Escape") {
        e.preventDefault()
        setDismissedRun({ scopeKey: opts.scopeKey, at: openRun.at })
        return
      }
      if (activeMention === null) return
      if (e.key === "ArrowDown") {
        // Clamped, not wrapping: the list is short and also mouse-driven, and a
        // jump from the last row back to the first reads as a different person
        // appearing under an unmoved cursor.
        e.preventDefault()
        setActiveIndex(Math.min(activeRow + 1, matches.length - 1))
      } else if (e.key === "ArrowUp") {
        e.preventDefault()
        setActiveIndex(Math.max(activeRow - 1, 0))
      } else if (e.key === "Enter") {
        // The only way a keyboard-only staffer can register a pick, and the
        // picked list is what decides who gets a bell — so this selects instead
        // of inserting a newline, sending, or saving.
        e.preventDefault()
        pick(activeMention)
      }
    },
  }
}
