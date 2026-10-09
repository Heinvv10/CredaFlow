"use client"

import { Button } from "@/components/ui/button"
import { ConversationView } from "@/components/comms/ConversationView"
import type { CannedReplyDTO, RosterMember, ThreadDTO } from "./types"

const STATUS_OPTIONS = ["OPEN", "PENDING_CUSTOMER", "PENDING_INTERNAL", "CLOSED"]
const PRIORITY_OPTIONS = ["NORMAL", "HIGH", "URGENT"]

type Props = {
  thread: ThreadDTO
  cannedReplies: CannedReplyDTO[]
  roster: RosterMember[]
  currentUserId: string
  canReconcile: boolean
  /** An admin may release a website chat a colleague holds. */
  canReleaseChats?: boolean
  busy: boolean
  fallback: { reason: string; detail?: string } | null
  onSend: (conversationId: string, text: string, operationId: string, channel: string) => Promise<boolean>
  onNote: (conversationId: string, text: string, mentionUserIds: string[]) => Promise<boolean>
  onEditNote: (noteId: string, text: string, mentionUserIds: string[]) => Promise<boolean>
  onDeleteNote: (noteId: string) => Promise<boolean>
  onClaim: () => void
  onRelease: () => void
  onReassign: (assigneeId: string) => void
  onStatus: (status: string) => void
  onPriority: (priority: string) => void
}

export function ThreadView(props: Props) {
  const cv = props.thread.conversation
  const mine = cv.assigneeId === props.currentUserId
  // Website chat: claiming is joining the visitor's chat window, releasing is
  // leaving it, and the server refuses a reassign outright.
  const websiteChat = cv.channel === "CHATBOT"
  const closed = cv.status === "CLOSED"

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-gray-200 bg-white px-4 py-2">
        <div className="min-w-0">
          <h2 className="truncate font-semibold text-gray-900">{props.thread.contact.displayName}</h2>
          <p className="text-xs text-gray-400">
            {cv.assigneeName ? `Assigned to ${cv.assigneeName}` : "Unassigned"}
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {!cv.assigneeId && <Button size="sm" onClick={props.onClaim} disabled={props.busy}>{websiteChat && !closed ? "Join chat" : "Claim"}</Button>}
          {/* An ended website chat has nobody to hand back to: no leave or release on it. */}
          {mine && !(websiteChat && closed) && <Button size="sm" variant="outline" onClick={props.onRelease} disabled={props.busy}>{websiteChat ? "Leave chat" : "Release"}</Button>}
          {/* A colleague who walked away from a chat still holds it: an admin can hand it back to the assistant. */}
          {websiteChat && !closed && cv.assigneeId && !mine && props.canReleaseChats && <Button size="sm" variant="outline" onClick={props.onRelease} disabled={props.busy}>Release chat</Button>}
          {/* The global `select { color, background-color }` remap (globals.css)
              targets the closed control only — background-color doesn't
              cascade to <option>, so the native popup rows fell back to the
              browser's default (often white) background while inheriting the
              remapped light `--cf-text` colour in dark theme, i.e. illegible.
              Set both explicitly per-<option> so the dropdown list itself is
              themed, not just the closed box. */}
          {!websiteChat && <select value="" onChange={(e) => e.target.value && props.onReassign(e.target.value)} className="rounded-md border border-gray-300 px-1.5 py-1 text-xs">
            <option value="" className="bg-[var(--cf-bg-raised)] text-[var(--cf-text)]">Reassign…</option>
            {props.roster.filter((m) => m.isCommsAgent).map((m) => (
              <option key={m.id} value={m.id} className="bg-[var(--cf-bg-raised)] text-[var(--cf-text)]">{m.name ?? m.email}</option>
            ))}
          </select>}
          <select value={cv.status} onChange={(e) => props.onStatus(e.target.value)} className="rounded-md border border-gray-300 px-1.5 py-1 text-xs">
            {STATUS_OPTIONS.map((s) => (
              <option key={s} value={s} className="bg-[var(--cf-bg-raised)] text-[var(--cf-text)]">{s}</option>
            ))}
          </select>
          <select value={cv.priority} onChange={(e) => props.onPriority(e.target.value)} className="rounded-md border border-gray-300 px-1.5 py-1 text-xs">
            {PRIORITY_OPTIONS.map((p) => (
              <option key={p} value={p} className="bg-[var(--cf-bg-raised)] text-[var(--cf-text)]">{p}</option>
            ))}
          </select>
        </div>
      </div>
      {websiteChat && (
        <div className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-900">
          Visitor details are not verified. Do not discuss any account in this chat.
        </div>
      )}

      <div className="flex min-h-0 flex-1 flex-col">
        <ConversationView
          conversationId={cv.id}
          messages={props.thread.messages}
          canReconcile={props.canReconcile}
          channel={props.thread.conversation.channel}
          window={props.thread.window}
          cannedReplies={props.cannedReplies}
          busy={props.busy}
          fallback={props.fallback}
          currentUserId={props.currentUserId}
          availableChannels={props.thread.reply.availableChannels}
          defaultChannel={props.thread.reply.defaultChannel}
          chatTakeover={websiteChat ? { assigneeId: cv.assigneeId, assigneeName: cv.assigneeName, closed } : undefined}
          onSend={props.onSend}
          onNote={props.onNote}
          onEditNote={props.onEditNote}
          onDeleteNote={props.onDeleteNote}
        />
      </div>
    </div>
  )
}
