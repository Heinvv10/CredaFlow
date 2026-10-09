import { listConversations, type ConversationSummary, type InboxQueue } from "./conversations"

export async function getInboxDeltas(a: {
  tenantId: string
  agentUserId: string
  queue: InboxQueue
  since: string | null
  limit?: number
}): Promise<{ conversations: ConversationSummary[]; cursor: string }> {
  const { conversations } = await listConversations({
    tenantId: a.tenantId,
    queue: a.queue,
    agentUserId: a.agentUserId,
    limit: a.limit ?? 50,
  })

  // First poll: establish a baseline without replaying history.
  if (a.since === null) {
    const newest = conversations.reduce<string>((max, c) => (c.updatedAt > max ? c.updatedAt : max), new Date(0).toISOString())
    return { conversations: [], cursor: conversations.length ? newest : new Date(0).toISOString() }
  }

  const changed = conversations.filter((c) => c.updatedAt > a.since!)
  const cursor = changed.reduce<string>((max, c) => (c.updatedAt > max ? c.updatedAt : max), a.since)
  return { conversations: changed, cursor }
}
