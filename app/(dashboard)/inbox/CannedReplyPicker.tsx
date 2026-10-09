"use client"

import type { CannedReplyDTO } from "./types"

/** Picks a saved reply for the draft. The composer decides where it is offered and how it is inserted. */
export function CannedReplyPicker(props: { replies: CannedReplyDTO[]; onPick: (body: string) => void }) {
  if (props.replies.length === 0) return null
  return (
    <select
      className="mb-2 w-full rounded-md border border-gray-300 px-2 py-1 text-xs text-gray-600"
      value=""
      onChange={(e) => {
        const cr = props.replies.find((r) => r.id === e.target.value)
        if (cr) props.onPick(cr.body)
      }}
    >
      <option value="" className="bg-[var(--cf-bg-raised)] text-[var(--cf-text)]">Insert canned reply…</option>
      {props.replies.map((r) => (
        <option key={r.id} value={r.id} className="bg-[var(--cf-bg-raised)] text-[var(--cf-text)]">{r.title}</option>
      ))}
    </select>
  )
}
