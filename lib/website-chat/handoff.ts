import { isCommsAgentAllowed } from "@/lib/inbox/comms-agent"
import { createNotification } from "@/lib/notifications/bell"
import { prisma } from "@/lib/prisma"
import { HANDOFF_WAIT_MS } from "./mode"
import { visitorLead } from "./store"

/** Conversations per tenant in any 60 minutes that are rung on the bell. Past it a flood of chats cannot bury every staff member's bell. */
export const MAX_HANDOFF_BELLS_PER_HOUR = 30

/**
 * Called once per hand-off, by the request that flipped the status: puts a bell item
 * in front of everyone with inbox access. The hand-off row itself is written with the
 * flip (store.ts), so a failure here loses the bell only, never the wait or the reply.
 *
 * Past the hourly cap nobody is rung; the chat still shows in the inbox as waiting.
 * The cap counts the conversations other than this one that were rung in the last
 * hour (from the bell items, which a join leaves in place): at 30 this one is not.
 * So the 30th conversation of the hour rings and the 31st does not, and a chat
 * handed off again within the hour rings again.
 */
export async function notifyStaffOfHandoff(a: { tenantId: string; conversationId: string; now: Date }): Promise<void> {
  const { tenantId, conversationId } = a
  await prisma.$transaction(async (tx) => {
    // One tenant's bells at a time, so the count below and the bells written after it cannot
    // interleave with another hand-off's: a burst could otherwise ring far past the cap. The
    // caller has committed the flip, so no Conversation row lock or daily lock is held here.
    // $executeRaw, not $queryRaw: the lock function returns void, which $queryRaw cannot deserialise.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${tenantId} || ':webchat-bell'))`
    const rung = await tx.notification.findMany({
      where: { tenantId, type: "CHAT_HANDOFF", entityId: { not: conversationId }, createdAt: { gte: new Date(a.now.getTime() - 60 * 60 * 1000) } },
      distinct: ["entityId"], select: { entityId: true }, take: MAX_HANDOFF_BELLS_PER_HOUR,
    })
    if (rung.length >= MAX_HANDOFF_BELLS_PER_HOUR) return
    // A cheap filter here; isCommsAgentAllowed stays the one definition of "has inbox access".
    const staff = await tx.user.findMany({
      where: { tenantId, active: true, OR: [{ isCommsAgent: true }, { role: { in: ["ADMIN", "SUPER_ADMIN"] } }] },
      select: { id: true, role: true, isCommsAgent: true },
    })
    const firstName = (await visitorLead(tx, tenantId, conversationId))?.firstName
    for (const u of staff) {
      if (!isCommsAgentAllowed(u.role, u.isCommsAgent)) continue
      await createNotification({
        tenantId, userId: u.id, type: "CHAT_HANDOFF", title: "Website chat needs a person",
        body: `${firstName || "A visitor"} is waiting on the website chat.`,
        entityType: "Conversation", entityId: conversationId,
      }, tx.notification)
    }
  })
}

/**
 * Conditional: sets timedOutAt only if still unjoined, un-timed-out and due. True for the one caller that won.
 *
 * The thread row is locked first. A staff join writes assigneeId on the Conversation, a
 * different row from the one updated here, so without the lock a join that is still
 * uncommitted would be invisible and the visitor would be told nobody came as staff arrive.
 */
export async function expireHandoffIfDue(a: { tenantId: string; conversationId: string; now: Date }): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Conversation" WHERE id = ${a.conversationId} AND "tenantId" = ${a.tenantId} FOR UPDATE`
    const { count } = await tx.websiteChatHandoff.updateMany({
      where: {
        conversationId: a.conversationId, tenantId: a.tenantId, timedOutAt: null,
        handedOffAt: { lte: new Date(a.now.getTime() - HANDOFF_WAIT_MS) },
        conversation: { assigneeId: null, closedAt: null, status: "PENDING_INTERNAL" },
      },
      data: { timedOutAt: a.now },
    })
    return count === 1
  })
}
