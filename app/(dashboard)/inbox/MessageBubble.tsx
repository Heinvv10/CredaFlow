"use client"

import { useState } from "react"
import type { ThreadMessage } from "./types"
import { SAST_TIME_ZONE } from "@/lib/utils"
import Link from "next/link"
import { requiresMessageReconciliation } from "@/lib/messaging/reconciliation"
import { mentionLabel, mentionsStillPresent, splitMentionHighlights } from "@/lib/inbox/mention-text"
import { splitNoteLinks } from "@/lib/inbox/note-links"
import { useMentionPicker } from "@/lib/inbox/use-mention-picker"
import { MentionPicker, type MentionableStaff } from "@/components/comms/MentionPicker"

// MsgStatus values (confirmed in schema): QUEUED, SENT, SIMULATED, DELIVERED, READ,
// FAILED, RETRYING, SUPPRESSED_BY_CONSENT, FAILED_PERMANENT, EXPIRED, BOUNCED.
const FAILED_STATUSES = new Set(["FAILED", "FAILED_PERMANENT", "SUPPRESSED_BY_CONSENT", "EXPIRED", "BOUNCED"])

function statusTicks(status: string): string {
  switch (status) {
    case "READ": return "✓✓"
    case "DELIVERED": return "✓✓"
    case "SENT": return "✓"
    case "SIMULATED": return "SIMULATED"
    case "QUEUED":
    case "RETRYING": return "🕓"
    default: return FAILED_STATUSES.has(status) ? "⚠" : ""
  }
}

// One thread carries every channel, so each bubble says how it travelled.
const CHANNEL_LABEL: Record<string, string> = { WHATSAPP: "WhatsApp", EMAIL: "Email", SMS: "SMS", CHATBOT: "Website chat" }

function timeLabel(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-ZA", { hour: "2-digit", minute: "2-digit", timeZone: SAST_TIME_ZONE })
}

export function MessageBubble({
  message,
  canReconcile = false,
  currentUserId,
  onEditNote,
  onDeleteNote,
}: {
  message: ThreadMessage
  canReconcile?: boolean
  currentUserId?: string
  onEditNote?: (noteId: string, text: string, mentionUserIds: string[]) => void
  onDeleteNote?: (noteId: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(message.bodyText ?? "")
  // The mentions this edit session will send. Seeded from the persisted rows
  // when editing starts — see the Edit button.
  const [mentions, setMentions] = useState<MentionableStaff[]>([])
  // The same picker the composer uses, from the same hook: a staffer who can
  // only tag someone while FIRST writing a note ends up editing one to say
  // "@Bo please chase" with nobody notified.
  const mention = useMentionPicker({
    enabled: editing,
    scopeKey: message.id,
    text: draft,
    currentUserId,
    onPick: (nextText, picked) => {
      setDraft(nextText)
      setMentions((prev) => (prev.some((m) => m.id === picked.id) ? prev : [...prev, picked]))
    },
  })

  if (message.isInternal || message.direction === "INTERNAL_NOTE") {
    if (message.deletedAt) {
      return (
        <div className="flex justify-center my-2">
          <div className="max-w-[80%] rounded-md border border-gray-200 bg-gray-50 px-3 py-2 text-xs italic text-gray-500">
            Note deleted by {message.deletedByName ?? "a colleague"}
            <span className="ml-2">{timeLabel(message.deletedAt)}</span>
          </div>
        </div>
      )
    }

    // Presentation only. The server re-checks authorship on every PATCH and
    // DELETE — hiding a button is not a permission.
    const mine = currentUserId !== undefined && message.createdById === currentUserId
    const canMutate = mine && (onEditNote !== undefined || onDeleteNote !== undefined)

    return (
      <div className="flex justify-center my-2">
        <div className="max-w-[80%] rounded-md bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-900">
          <span className="font-medium">Note{message.createdByName ? ` · ${message.createdByName}` : ""}:</span>{" "}
          {editing ? (
            <div className="mt-1">
              {mention.openRun !== null && (
                <MentionPicker
                  staff={mention.staff}
                  query={mention.openRun.query}
                  excludeUserId={currentUserId}
                  activeIndex={mention.activeRow}
                  onPick={mention.pick}
                />
              )}
              <textarea
                value={draft}
                onChange={(e) => {
                  // selectionStart, not the end of the value: an agent fixing a
                  // mention mid-sentence must get the run they are actually in.
                  const caretAt = e.target.selectionStart ?? e.target.value.length
                  mention.handleChange(e.target.value, caretAt)
                  setDraft(e.target.value)
                }}
                // Enter with the picker open selects the row and must NOT save
                // the note — the hook consumes it. With no picker open it stays
                // a plain newline; Save is a button here, not a keystroke.
                onKeyDown={mention.handleKeyDown}
                rows={2}
                className="w-full resize-none rounded border border-amber-300 bg-white p-1 text-xs text-amber-900"
              />
              <div className="mt-1 flex gap-2">
                <button
                  onClick={() => {
                    const text = draft.trim()
                    // Deleting the visible "@Jane" from the note must not still
                    // ping her, so the submitted text decides the list — the
                    // same rule the composer applies on submit.
                    onEditNote?.(message.id, text, mentionsStillPresent(mentions, text).map((m) => m.id))
                    setEditing(false)
                  }}
                  disabled={draft.trim() === ""}
                  className="rounded bg-amber-200 px-2 py-0.5 disabled:opacity-40"
                >
                  Save
                </button>
                <button onClick={() => { setDraft(message.bodyText ?? ""); setEditing(false) }} className="px-2 py-0.5">
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <>
              <span className="whitespace-pre-wrap break-words">
                {/* Highlighting only, from the persisted mention rows — never
                    re-derived from the text, so a note that merely says
                    "@somebody" doesn't read as a tag that nobody received. */}
                {/* mentionLabel, not `m.name`: the picker inserts "@email" for a
                    staffer with no name, so highlighting only names left that
                    mention rendered as plain text. */}
                {/* Plain <a>, not <Link>, for the fixed same-origin paths in
                    splitNoteLinks: a full navigation, like typing the path. */}
                {splitMentionHighlights(message.bodyText, message.mentions.map(mentionLabel)).flatMap((part, i) => (
                  part.mention
                    ? [<span key={i} className="font-medium text-amber-700">{part.text}</span>]
                    : splitNoteLinks(part.text).map((p, j) => (
                        p.href
                          ? <a key={`${i}.${j}`} href={p.href} className="underline">{p.text}</a>
                          : <span key={`${i}.${j}`}>{p.text}</span>
                      ))
                ))}
              </span>
              {message.editedAt && <span className="ml-1 italic text-amber-500">edited</span>}
              <span className="ml-2 text-amber-500">{timeLabel(message.createdAt)}</span>
              {canMutate && (
                <span className="ml-2">
                  {onEditNote && (
                    <button
                      onClick={() => {
                        // Both seeded from the same snapshot of the persisted
                        // note: saving an edit that never touched a mention has
                        // to re-send the ids it already has, or the payload
                        // silently drops every existing tag. The server treats
                        // mentions as additive and notifies only newly added
                        // ids, so re-sending them re-pings nobody.
                        setDraft(message.bodyText ?? "")
                        // `email ?? ""`: the DTO's email is nullable (the row
                        // survives a hard-deleted user) while the picker's is
                        // not. Only mentionLabel reads it, and it already
                        // prefers the name — a mention with neither could never
                        // have been inserted as a visible tag in the first place.
                        setMentions(message.mentions.map((m) => ({ id: m.userId, name: m.name, email: m.email ?? "" })))
                        setEditing(true)
                      }}
                      className="underline"
                    >
                      Edit
                    </button>
                  )}
                  {onDeleteNote && <button onClick={() => onDeleteNote(message.id)} className="ml-2 underline">Delete</button>}
                </span>
              )}
            </>
          )}
        </div>
      </div>
    )
  }

  const outbound = message.direction === "OUTBOUND"
  const failed = FAILED_STATUSES.has(message.status)
  const reconciliationRequired = requiresMessageReconciliation(message)
  return (
    <div className={`flex ${outbound ? "justify-end" : "justify-start"} my-1`}>
      <div
        className={`max-w-[75%] rounded-lg px-3 py-2 text-sm ${
          outbound
            ? "bg-emerald-600 text-white"
            : "border border-[var(--cf-border-strong)] bg-[var(--cf-bg-raised)] text-gray-900"
        }`}
      >
        {message.hasMedia && (
          <div className={`mb-1 text-xs italic ${outbound ? "text-emerald-100" : "text-gray-500"}`}>
            [media — open in WhatsApp]
          </div>
        )}
        <div className="whitespace-pre-wrap break-words">{message.bodyText ?? ""}</div>
        <div className={`mt-1 flex items-center gap-1 text-[10px] ${outbound ? "text-emerald-100" : "text-gray-400"}`}>
          <span data-testid="message-channel">{CHANNEL_LABEL[message.channel] ?? message.channel}</span>
          <span>·</span>
          <span>{timeLabel(message.createdAt)}</span>
          {outbound && <span className={failed || reconciliationRequired ? "text-amber-100" : ""}>{reconciliationRequired ? "⚠" : statusTicks(message.status)}</span>}
        </div>
        {failed && message.errorMessage && (
          <div className="mt-1 text-[10px] text-red-200">{message.errorMessage}</div>
        )}
        {reconciliationRequired ? (
          // Opaque panel background, not the translucent bg-amber-50 tint used
          // elsewhere: this chip can sit inside a solid bg-emerald-600 bubble
          // (outbound), and a translucent amber-over-green composite reads as
          // dark-green-on-green — illegible. Opaque bg-white (remapped to the
          // theme panel colour) plus the text-amber-900 remap (warning token)
          // gives a real light/dark chip regardless of the parent bubble.
          <div className="mt-2 rounded border border-amber-200 bg-white px-2 py-1 text-[11px] font-semibold text-amber-900">
            Manual reconciliation required; automatic retry blocked.
            {canReconcile ? (
              <>{" "}<Link href={`/inbox/reconciliation?messageId=${encodeURIComponent(message.id)}`} className="underline">Resolve</Link></>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  )
}
