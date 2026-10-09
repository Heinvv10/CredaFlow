import type { prisma } from "@/lib/prisma"
import { sastStartOfDay } from "@/lib/date/sast"

type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0]

/**
 * The conversation filter is a superset pre-filter so Postgres can start from the
 * (tenantId, channel, …, lastInboundAt) Conversation index and then walk the
 * (tenantId, conversationId, createdAt) Message index, instead of scanning every
 * tenant message. The hour of slack covers a thread whose lastInboundAt was
 * stamped from a request clock read a moment before midnight.
 */
const PREFILTER_SLACK_MS = 60 * 60 * 1000

/**
 * Visitor messages the tenant's website chats have taken for the assistant since
 * SAST midnight. Each one is a model call, so this is what DAILY_BOT_REPLY_CAP is
 * measured against.
 *
 * Only provider CHATBOT rows: a message kept for staff (written while staff hold the
 * chat or are waited for, or refused for a cap) is stored as MANUAL (store.ts) and costs
 * no model call. Counting those would let one visitor spend the tenant's day of answers.
 * Call it inside the transaction that holds the tenant's daily chat lock.
 */
export function countTodaysVisitorMessages(tx: Pick<Tx, "message">, tenantId: string, now: Date): Promise<number> {
  const dayStart = sastStartOfDay(now)
  return tx.message.count({
    where: {
      tenantId, channel: "CHATBOT", provider: "CHATBOT", direction: "INBOUND", createdAt: { gte: dayStart },
      conversation: { tenantId, channel: "CHATBOT", lastInboundAt: { gte: new Date(dayStart.getTime() - PREFILTER_SLACK_MS) } },
    },
  })
}
