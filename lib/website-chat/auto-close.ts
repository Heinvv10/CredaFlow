import type { ConvStatus } from "@prisma/client"
import { logAuditStrict } from "@/lib/audit"
import { prisma } from "@/lib/prisma"

/** A website chat idle this long is closed, unless it is waiting on staff (PENDING_INTERNAL). */
const CHAT_IDLE_CLOSE_MS = 24 * 60 * 60 * 1000
/** Per tenant per run; the hourly schedule drains any backlog. */
const BATCH = 500

/**
 * Idle means no message AND no staff action for the window. Staff status changes,
 * assignment and notes bump updatedAt but not lastActivityAt, so a thread staff
 * touch (e.g. move to PENDING_CUSTOMER after a call-back) gets a fresh 24h from
 * that action before it can close; staff can always reopen it.
 */
function idleWhere(tenantId: string, now: Date) {
  const cutoff = new Date(now.getTime() - CHAT_IDLE_CLOSE_MS)
  return {
    tenantId, channel: "CHATBOT" as const, closedAt: null,
    status: { in: ["OPEN", "PENDING_CUSTOMER"] as ConvStatus[] },
    lastActivityAt: { lt: cutoff }, updatedAt: { lt: cutoff },
  }
}

/**
 * Closes one chat and audits it in the same transaction. The close repeats the
 * whole rule and the status that was read, so a thread that got a message or
 * was handed off since it was picked is left open, with no audit row.
 */
export async function closeIfStillIdle(tenantId: string, chat: { id: string; status: ConvStatus }, now: Date): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const { count } = await tx.conversation.updateMany({
      where: { ...idleWhere(tenantId, now), id: chat.id, status: chat.status },
      data: { status: "CLOSED", closedAt: now },
    })
    if (count !== 1) return false
    await logAuditStrict({
      tenantId, action: "WEBSITE_CHAT_AUTO_CLOSED", entity: "Conversation", entityId: chat.id,
      oldValue: { status: chat.status }, newValue: { status: "CLOSED", rule: "website_chat_idle_24h" },
    }, tx)
    return true
  })
}

export async function closeIdleChats(tenantId: string, now: Date): Promise<{ closed: number }> {
  const idle = await prisma.conversation.findMany({
    where: idleWhere(tenantId, now), select: { id: true, status: true }, orderBy: { lastActivityAt: "asc" }, take: BATCH,
  })
  let closed = 0
  for (const chat of idle) if (await closeIfStillIdle(tenantId, chat, now)) closed++
  return { closed }
}
