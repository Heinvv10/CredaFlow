"use client"

import { useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { MentionPicker, type MentionableStaff } from "@/components/comms/MentionPicker"
import { mentionsStillPresent } from "@/lib/inbox/mention-text"
import { useMentionPicker } from "@/lib/inbox/use-mention-picker"
import { SAST_TIME_ZONE } from "@/lib/utils"
import { MAX_STAFF_REPLY_CHARS } from "@/lib/website-chat/constants"
import { CannedReplyPicker } from "./CannedReplyPicker"
import { ChatTakeoverBar, chatReplyBlock, type ChatTakeover } from "./ChatTakeoverBar"
import type { CannedReplyDTO } from "./types"

type Props = {
  conversationId: string
  channel: string
  windowOpen: boolean
  expiresAt: string | null
  cannedReplies: CannedReplyDTO[]
  sending: boolean
  // The signed-in staffer, so the picker can leave their own row out: a
  // self-mention is discarded server-side, so picking it tags nobody.
  currentUserId?: string
  /** Channels this contact actually has an identity on. Empty = no reply possible. */
  availableChannels: string[]
  /** Channel of the newest inbound message on the thread. */
  defaultChannel: string
  chatTakeover?: ChatTakeover
  onSend: (conversationId: string, text: string, operationId: string, channel: string) => Promise<boolean>
  onNote?: (conversationId: string, text: string, mentionUserIds: string[]) => Promise<boolean>
  fallback: { reason: string; detail?: string } | null
}

const FALLBACK_COPY: Record<string, string> = {
  // CHANNEL_DISABLED is intentionally absent — its `detail` (e.g. "WhatsApp
  // channel is disabled.") is more specific than any generic line.
  NO_DESTINATION: "This contact has no address for this channel.",
  SEND_BLOCKED: "Send blocked by consent (customer opted out).",
  SEND_FAILED: "Message could not be sent right now.",
  RECONCILIATION_REQUIRED: "Provider outcome requires reconciliation. Do not resend this reply.",
  SIMULATED: "Dry-run only: this reply was recorded but not sent.",
  PENDING: "This reply is queued or retrying. Do not submit a duplicate.",
  NOTE_FAILED: "Note could not be saved. Nothing was recorded — try again.",
}

function fallbackText(fallback: { reason: string; detail?: string }): string {
  return FALLBACK_COPY[fallback.reason] ?? fallback.detail ?? fallback.reason
}

const REPLY_CHANNELS = ["WHATSAPP", "EMAIL"] as const
const CHANNEL_LABEL: Record<string, string> = { WHATSAPP: "WhatsApp", EMAIL: "Email" }

function sastTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-ZA", {
    timeZone: SAST_TIME_ZONE, hour: "2-digit", minute: "2-digit", hour12: false,
  })
}

export function Composer(props: Props) {
  const websiteChat = props.channel === "CHATBOT"
  const channels = websiteChat ? [] : REPLY_CHANNELS.filter((c) => props.availableChannels.includes(c))
  // Meta's 24h rule: outside the window WhatsApp needs an approved template, so
  // free text on it is simply not offered.
  const waBlocked = !props.windowOpen
  function initialChannel(): string {
    if (props.defaultChannel === "WHATSAPP" && waBlocked && channels.includes("EMAIL")) return "EMAIL"
    if (channels.includes(props.defaultChannel as (typeof REPLY_CHANNELS)[number])) return props.defaultChannel
    return channels.find((c) => c !== "WHATSAPP" || !waBlocked) ?? channels[0] ?? props.defaultChannel
  }
  // Outbound replies dispatch over WhatsApp and EMAIL (threaded). Other channels
  // (SMS/voice) can't dispatch yet, so we force internal-note mode and explain —
  // rather than letting the agent hit a misleading "could not be sent" error.
  // A website chat is answered in the visitor's chat window, never on an address,
  // and only by the staffer who joined it. Notes stay available in every state.
  const chatBlock = props.chatTakeover ? chatReplyBlock(props.chatTakeover, props.currentUserId) : null
  const replyEnabled = websiteChat ? props.chatTakeover !== undefined && chatBlock === null : channels.length > 0
  // Surfaces that don't pass onNote hide the note toggle entirely.
  const notesAllowed = typeof props.onNote === "function"
  type Draft = { text: string; noteMode: boolean; operationId: string | null; mentions: MentionableStaff[]; channel: string }
  const draftsRef = useRef(new Map<string, Draft>())
  const [drafts, setDrafts] = useState(() => new Map<string, Draft>())
  const draft = drafts.get(props.conversationId)
    ?? { text: "", noteMode: false, operationId: null, mentions: [], channel: websiteChat ? "CHATBOT" : initialChannel() }
  const text = draft.text
  const channel = draft.channel
  // The 24h session window is a WhatsApp-only rule; email has no such window.
  const showWindow = channel === "WHATSAPP"
  const effectiveNote = notesAllowed ? (!replyEnabled || draft.noteMode) : false
  // When a channel can neither reply nor take notes, the composer is a read-only notice.
  const readOnlyNotice = !replyEnabled && !notesAllowed

  // The run, the roster, the caret and the keyboard live in the shared hook —
  // the inline note editor in MessageBubble drives the same picker, and two
  // copies of this would drift into tagging different people.
  const mention = useMentionPicker({
    enabled: effectiveNote,
    scopeKey: props.conversationId,
    text,
    currentUserId: props.currentUserId,
    // The pick is recorded on the DRAFT, so it survives a thread switch exactly
    // like the text does, and submit() has it to filter.
    onPick: (nextText, picked) => {
      updateDraft(props.conversationId, {
        ...draft,
        text: nextText,
        operationId: draft.operationId,
        mentions: draft.mentions.some((m) => m.id === picked.id) ? draft.mentions : [...draft.mentions, picked],
      })
    },
  })

  function updateDraft(conversationId: string, next: Draft | null) {
    const updated = new Map(draftsRef.current)
    if (next) updated.set(conversationId, next)
    else updated.delete(conversationId)
    draftsRef.current = updated
    setDrafts(updated)
  }

  async function submit() {
    const conversationId = props.conversationId
    const submittedDraft = draftsRef.current.get(conversationId) ?? draft
    const t = submittedDraft.text.trim()
    if (t === "") return
    if (!effectiveNote && submittedDraft.channel === "WHATSAPP" && waBlocked) return
    if (effectiveNote) {
      // Mirror the reply path below: don't discard the typed note until the
      // request actually succeeds, or a failed POST silently loses the text
      // the staffer just typed. No operationId here — a duplicate note is
      // recoverable and costs nothing, unlike a duplicate customer message,
      // so notes deliberately have no idempotency key.
      // Deleting the visible "@Jane" must not silently still ping her, so the
      // submitted text decides the list — not the pick history.
      const stillPresent = mentionsStillPresent(submittedDraft.mentions, t)
      const accepted = await props.onNote?.(conversationId, t, stillPresent.map((m) => m.id))
      if (accepted) {
        const latest = draftsRef.current.get(conversationId)
        // Never clear a newer edit that arrived while this request was in flight.
        if (latest?.text === submittedDraft.text) {
          updateDraft(conversationId, null)
        }
      }
      return
    }
    const currentOperationId = submittedDraft.operationId ?? crypto.randomUUID()
    updateDraft(conversationId, { ...submittedDraft, operationId: currentOperationId })
    const accepted = await props.onSend(conversationId, t, currentOperationId, submittedDraft.channel)
    if (accepted) {
      const latest = draftsRef.current.get(conversationId)
      // Never clear a newer edit or retry while this request was in flight.
      if (latest?.operationId === currentOperationId && latest.text === submittedDraft.text) {
        updateDraft(conversationId, null)
      }
    }
  }

  return (
    <div className="border-t border-gray-200 bg-white p-3">
      {websiteChat && <ChatTakeoverBar takeover={props.chatTakeover} block={chatBlock} notesAllowed={notesAllowed} />}
      {!websiteChat && !replyEnabled && notesAllowed && (
        <div className="mb-2 rounded-md bg-blue-50 border border-blue-200 px-3 py-2 text-xs text-blue-900">
          Outbound replies aren&apos;t available on this channel yet. Reach this customer via WhatsApp or email (channel-of-record). You can still add an internal note below.
        </div>
      )}
      {!websiteChat && readOnlyNotice && (
        <div className="rounded-md bg-blue-50 border border-blue-200 px-3 py-2 text-xs text-blue-900">
          Outbound replies aren&apos;t available on this channel yet. Reach this customer via WhatsApp or email (channel-of-record).
        </div>
      )}
      {/* A note is offered on every channel (not just replyEnabled ones), so a
          failed note needs to surface here too — otherwise a failed POST on an
          SMS/voice thread looks identical to success. */}
      {props.fallback && (replyEnabled || effectiveNote) && (
        <div className="mb-2 rounded-md bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-900">
          {(websiteChat && props.fallback.detail) || fallbackText(props.fallback)}
          {/* This suffix tells the agent to go contact the customer, which is
              wrong advice for a failed internal note — it was never meant to
              reach them. */}
          {!effectiveNote && !websiteChat && " Consider reaching the customer on another channel (channel-of-record)."}
        </div>
      )}
      {!readOnlyNotice && (
        <>
          <div className="mb-2 flex items-center gap-2 text-xs">
            {notesAllowed && (
              <>
                <button
                  onClick={() => {
                    if (replyEnabled) updateDraft(props.conversationId, { ...draft, noteMode: false })
                  }}
                  disabled={!replyEnabled}
                  className={`rounded px-2 py-1 ${!effectiveNote ? "bg-emerald-100 text-emerald-800" : "text-gray-500"} ${!replyEnabled ? "cursor-not-allowed opacity-40" : ""}`}
                >
                  Reply
                </button>
                <button onClick={() => updateDraft(props.conversationId, { ...draft, noteMode: true })} className={`rounded px-2 py-1 ${effectiveNote ? "bg-amber-100 text-amber-800" : "text-gray-500"}`}>Internal note</button>
              </>
            )}
            {!effectiveNote && showWindow && (
              <span className={`ml-auto ${props.windowOpen ? "text-emerald-600" : "text-gray-400"}`}>
                {props.windowOpen && props.expiresAt
                  ? `WhatsApp: free reply until ${sastTime(props.expiresAt)}`
                  : props.windowOpen
                    ? "● 24h window open"
                    : "○ window closed"}
              </span>
            )}
          </div>

          {!effectiveNote && channels.length > 0 && (
            <div className="mb-2 flex items-center gap-1 text-xs">
              {channels.map((c) => {
                const blocked = c === "WHATSAPP" && waBlocked
                return (
                  <button
                    key={c}
                    data-channel={c}
                    disabled={blocked}
                    onClick={() => { if (!blocked) updateDraft(props.conversationId, { ...draft, channel: c }) }}
                    className={`rounded px-2 py-1 ${channel === c ? "bg-emerald-100 text-emerald-800" : "text-gray-500"} ${blocked ? "cursor-not-allowed opacity-40" : ""}`}
                  >
                    {CHANNEL_LABEL[c]}{blocked ? " — window closed — template only" : ""}
                  </button>
                )
              })}
            </div>
          )}

          {/* Canned replies are written for verified customers and may mention accounts: never offered to a website visitor. */}
          {!effectiveNote && !websiteChat && (
            <CannedReplyPicker
              replies={props.cannedReplies}
              onPick={(body) => updateDraft(props.conversationId, { ...draft, text: draft.text ? `${draft.text}\n${body}` : body })}
            />
          )}

          {mention.openRun !== null && (
            <MentionPicker
              staff={mention.staff}
              query={mention.openRun.query}
              excludeUserId={props.currentUserId}
              activeIndex={mention.activeRow}
              onPick={mention.pick}
            />
          )}

          <div className="flex items-end gap-2">
            <Textarea
              value={text}
              onChange={(e) => {
                // selectionStart, not the end of the value: an agent fixing a
                // mention mid-sentence must get the run they are actually in.
                const caretAt = e.target.selectionStart ?? e.target.value.length
                mention.handleChange(e.target.value, caretAt)
                updateDraft(props.conversationId, {
                  ...draft,
                  text: e.target.value,
                  // A false send result can mean provider uncertainty. Keep
                  // the key across edits so the server rejects a conflicting
                  // payload instead of reserving another occurrence.
                  operationId: draft.operationId,
                })
              }}
              onKeyDown={(e) => {
                // Checked before the picker: Cmd/Ctrl+Enter is the send/save
                // keystroke on the reply path too, and must not be swallowed
                // just because a mention query happens to be open.
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { submit(); return }
                mention.handleKeyDown(e)
              }}
              placeholder={effectiveNote ? "Add an internal note (never sent)…" : websiteChat ? "Reply to the visitor in the website chat…" : "Type a reply…"}
              maxLength={websiteChat && !effectiveNote ? MAX_STAFF_REPLY_CHARS : undefined}
              rows={2}
              className="flex-1 resize-none"
            />
            <Button
              onClick={submit}
              disabled={props.sending || text.trim() === "" || (!effectiveNote && channel === "WHATSAPP" && waBlocked)}
            >
              {effectiveNote ? "Add note" : props.sending ? "Sending…" : "Send"}
            </Button>
          </div>
        </>
      )}
    </div>
  )
}
