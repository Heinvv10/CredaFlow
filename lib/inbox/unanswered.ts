import { prisma } from "@/lib/prisma"

/**
 * Conversations where the CUSTOMER spoke last and nobody has replied.
 *
 * "Unanswered" is deliberately not "unread": a message can be opened and read
 * by an agent who never replies, and that conversation is still owed a
 * response. The inbox's per-row unreadCount answers "have I looked at this";
 * this answers "does a customer have an outstanding question", which is what
 * the sidebar badge is claiming.
 *
 * A WhatsApp reply window is 24h and a Section 129 exchange can be
 * time-sensitive, so a customer waiting on us is the thing worth surfacing on
 * every page rather than only inside the inbox.
 *
 * Website chat (CHATBOT) is the exception: the bot always answers, so such a
 * thread is only counted once it has been handed off (PENDING_INTERNAL), or
 * while a staffer holds it and the visitor wrote last (waiting on that person).
 *
 * CLOSED conversations are excluded — closing is the explicit "this is
 * finished" action, and a badge that counted them could never reach zero.
 */
export async function countUnansweredConversations(tenantId: string): Promise<number> {
  // Prisma cannot compare two columns in a `where` without field references,
  // which this codebase does not use anywhere else. Raw SQL keeps the
  // comparison in one readable place and runs as a single indexed count
  // rather than loading rows into JS to filter them.
  const rows = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT count(*)::bigint AS count
    FROM "Conversation"
    WHERE "tenantId" = ${tenantId}
      AND "status" <> 'CLOSED'
      AND (
        ("channel" <> 'CHATBOT'
          AND "lastInboundAt" IS NOT NULL
          AND ("lastOutboundAt" IS NULL OR "lastOutboundAt" < "lastInboundAt"))
        -- Website chat: the bot always answers, so only a hand-off is owed a response,
        -- or a chat a staffer holds whose visitor wrote last (closed ones are out above).
        OR ("channel" = 'CHATBOT' AND "status" = 'PENDING_INTERNAL')
        OR ("channel" = 'CHATBOT' AND "assigneeId" IS NOT NULL AND "lastInboundAt" IS NOT NULL
          AND ("lastOutboundAt" IS NULL OR "lastInboundAt" > "lastOutboundAt"))
      )
  `
  return Number(rows[0]?.count ?? 0)
}
