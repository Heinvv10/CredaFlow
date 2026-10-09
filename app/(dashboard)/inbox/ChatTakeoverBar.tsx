/**
 * Who holds a website chat, as the thread reports it. A surface that passes none
 * (the client comms tab) offers no joining, so the chat is read-only there.
 */
export type ChatTakeover = { assigneeId: string | null; assigneeName: string | null; closed: boolean }

/**
 * Why this staffer cannot answer the visitor, or null when they can. The server
 * refuses the same three cases; saying so up front spares the agent a typed
 * reply that would be turned away.
 */
export function chatReplyBlock(takeover: ChatTakeover, currentUserId?: string): string | null {
  if (takeover.closed) return "This chat has ended."
  if (!takeover.assigneeId) return "Join the chat to reply to the visitor."
  if (takeover.assigneeId !== currentUserId) return `Taken by ${takeover.assigneeName ?? "a colleague"}.`
  return null
}

type Props = {
  takeover?: ChatTakeover
  block: string | null
  notesAllowed: boolean
}

export function ChatTakeoverBar(props: Props) {
  if (props.takeover && props.block === null) return null
  return (
    <div className="mb-2 rounded-md bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-900">
      {props.takeover
        ? props.block
        : <>Website chat with the AI assistant. The visitor can&apos;t receive replies here. Their details are not verified. Phone them on the number in the first note{props.notesAllowed ? ", and add an internal note below" : ""}.</>}
    </div>
  )
}
