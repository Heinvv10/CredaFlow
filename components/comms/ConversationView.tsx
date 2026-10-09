"use client"

import { MessageBubble } from "@/app/(dashboard)/inbox/MessageBubble"
import { Composer } from "@/app/(dashboard)/inbox/Composer"
import type { ThreadMessage } from "@/lib/inbox/conversations"
import type { CannedReplyDTO } from "@/app/(dashboard)/inbox/types"
import type { ChatTakeover } from "@/app/(dashboard)/inbox/ChatTakeoverBar"
import { SAST_TIME_ZONE } from "@/lib/utils"

function dayLabel(iso: string): string {
  return new Date(iso).toLocaleDateString("en-ZA", { weekday: "short", day: "numeric", month: "short", timeZone: SAST_TIME_ZONE })
}

type MessageRow = { message: ThreadMessage; day: string; showDay: boolean }

function toRows(messages: ThreadMessage[]): MessageRow[] {
  const rows: MessageRow[] = []
  let lastDay = ""
  for (const m of messages) {
    const day = dayLabel(m.createdAt)
    rows.push({ message: m, day, showDay: day !== lastDay })
    lastDay = day
  }
  return rows
}

type Props = {
  conversationId: string
  messages: ThreadMessage[]
  canReconcile?: boolean
  channel: string
  window: { open: boolean; expiresAt: string | null } | null
  cannedReplies: CannedReplyDTO[]
  busy: boolean
  fallback: { reason: string; detail?: string } | null
  currentUserId?: string
  availableChannels: string[]
  defaultChannel: string
  chatTakeover?: ChatTakeover
  onSend: (conversationId: string, text: string, operationId: string, channel: string) => Promise<boolean>
  onNote?: (conversationId: string, text: string, mentionUserIds: string[]) => Promise<boolean>
  onEditNote?: (noteId: string, text: string, mentionUserIds: string[]) => Promise<boolean>
  onDeleteNote?: (noteId: string) => Promise<boolean>
}

export function ConversationView(props: Props) {
  const rows = toRows(props.messages)

  // Root fills 100% of its parent (`h-full`); each caller wraps it in a
  // bounded-height box (inbox: a `flex-1 min-h-0` wrapper; client tab: a fixed-
  // height grid cell). The message list then scrolls with the composer pinned.
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex-1 overflow-y-auto bg-gray-100 px-4 py-2">
        {rows.map(({ message: m, day, showDay }) => (
          <div key={m.id}>
            {showDay && (
              <div className="my-2 flex justify-center">
                <span className="rounded-full bg-white px-2 py-0.5 text-[10px] text-gray-400 shadow-sm">{day}</span>
              </div>
            )}
            <MessageBubble
              message={m}
              canReconcile={props.canReconcile === true}
              currentUserId={props.currentUserId}
              onEditNote={props.onEditNote ? (noteId, text, mentionUserIds) => { props.onEditNote?.(noteId, text, mentionUserIds) } : undefined}
              onDeleteNote={props.onDeleteNote ? (noteId) => { props.onDeleteNote?.(noteId) } : undefined}
            />
          </div>
        ))}
        {rows.length === 0 && <p className="mt-8 text-center text-sm text-gray-400">No messages yet.</p>}
      </div>

      <Composer
        conversationId={props.conversationId}
        channel={props.channel}
        windowOpen={props.window?.open ?? false}
        expiresAt={props.window?.expiresAt ?? null}
        cannedReplies={props.cannedReplies}
        sending={props.busy}
        currentUserId={props.currentUserId}
        availableChannels={props.availableChannels}
        defaultChannel={props.defaultChannel}
        chatTakeover={props.chatTakeover}
        onSend={props.onSend}
        onNote={props.onNote}
        fallback={props.fallback}
      />
    </div>
  )
}
