export type { ConversationSummary, ThreadDTO, ThreadMessage, InboxQueue } from "@/lib/inbox/conversations"

export type RosterMember = { id: string; name: string | null; email: string; role: string; isCommsAgent: boolean }
export type CannedReplyDTO = { id: string; title: string; body: string }
