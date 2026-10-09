import { Prisma } from "@prisma/client"
import type { prisma } from "@/lib/prisma"

// What every website-chat writer shares: the row shapes it writes, and how it stamps the thread.
export type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0]

export const CHAT = { channel: "CHATBOT" as const, provider: "CHATBOT" as const }

/** Written into the first note by startChat; the only link from the chat back to its Lead. */
export const LEAD_LINK = "CRM lead: /crm/leads/"

export function note(tenantId: string, conversationId: string, bodyText: string) {
  return { tenantId, conversationId, channel: CHAT.channel, direction: "INTERNAL_NOTE" as const, provider: "MANUAL" as const, isInternal: true, bodyText }
}

// A JS Date reaches raw SQL as timestamptz; the columns are UTC timestamps without a zone.
// Converting explicitly keeps the stored instant right whatever the session's time zone.
export const utc = (d: Date) => Prisma.sql`(${d}::timestamptz AT TIME ZONE 'UTC')`

/**
 * Moves the thread's stamps forward, never back. Each request reads its clock when it starts,
 * so two can commit in the other order; a stamp that moved back would let the abandoned-chat
 * release (staff.ts) fire early, or rank the chat below older traffic. GREATEST keeps a stored
 * NULL from winning. lastOutboundAt is then recomputed by the database
 * (Conversation_truthful_last_outbound: the latest sentAt of the thread's sent messages) whenever
 * this changes it, which agrees: never writing a smaller value means never asking it to.
 */
export async function stampThread(tx: Tx, a: { tenantId: string; conversationId: string; direction: "inbound" | "outbound"; at: Date }): Promise<void> {
  const column = Prisma.raw(a.direction === "inbound" ? '"lastInboundAt"' : '"lastOutboundAt"')
  await tx.$executeRaw`UPDATE "Conversation"
    SET ${column} = GREATEST(${column}, ${utc(a.at)}), "lastActivityAt" = GREATEST("lastActivityAt", ${utc(a.at)}), "updatedAt" = ${utc(new Date())}
    WHERE id = ${a.conversationId} AND "tenantId" = ${a.tenantId}`
}
