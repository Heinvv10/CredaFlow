// Conversation ordering, shared by the server list query and the client's
// poll-merge. Deliberately free of any prisma import: InboxClient.tsx is a
// client component, and pulling lib/inbox/conversations.ts (which imports
// prisma) into the browser bundle is a build-time failure.
//
// WHY THIS EXISTS: listConversations orders by `lastActivityAt desc NULLS
// LAST, id desc`, but the client's 4s delta poll re-sorted the merged list by
// lastMessageAt. Those disagreed, so the queue reshuffled on the first poll
// tick.
//
// WHY THE KEY IS lastActivityAt: the sort key used to be lastInboundAt, which
// is null on any thread the customer has never replied to. NULLS LAST then put
// every outbound-only conversation below every conversation that ever got a
// reply, however old — 41 of 106 PROD conversations on 2026-08-20, all of them
// past the 30-row first page and invisible to staff. lastActivityAt is the
// later of lastInboundAt and lastOutboundAt, maintained by every writer of
// either. lastInboundAt is still the right key for "does a customer await a
// reply" (lib/inbox/unanswered.ts) and for the unread badge — those must NOT
// move to lastActivityAt.

export type ConversationOrderKey = {
  lastActivityAt: string | null
  id: string
}

// Mirrors Prisma's `[{ lastActivityAt: { sort: "desc", nulls: "last" } }, { id: "desc" }]`.
// ISO-8601 UTC strings compare correctly lexicographically, which is why
// localeCompare on the raw string is sound here.
export function compareConversations(a: ConversationOrderKey, b: ConversationOrderKey): number {
  // NULLS LAST still applies, but only a thread with no traffic at all can be
  // null now — the backfill gave every pre-existing row a value.
  if (a.lastActivityAt === null && b.lastActivityAt === null) return b.id.localeCompare(a.id)
  if (a.lastActivityAt === null) return 1
  if (b.lastActivityAt === null) return -1
  const byActivity = b.lastActivityAt.localeCompare(a.lastActivityAt)
  return byActivity !== 0 ? byActivity : b.id.localeCompare(a.id)
}
