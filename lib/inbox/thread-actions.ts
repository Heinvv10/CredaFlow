import { prisma } from "@/lib/prisma"
import { logAudit } from "@/lib/audit"
import { isOneOpenPerContactConflict } from "./resolve-thread"

export async function markConversationRead(a: {
  tenantId: string; conversationId: string; now?: Date
}): Promise<{ marked: number }> {
  const res = await prisma.message.updateMany({
    where: { tenantId: a.tenantId, conversationId: a.conversationId, direction: "INBOUND", readAt: null },
    data: { readAt: a.now ?? new Date() },
  })
  return { marked: res.count }
}

/**
 * NOT_FOUND — no such conversation in this tenant.
 * ANOTHER_THREAD_OPEN — reopening this thread would give the contact a second
 * open thread, which Conversation_one_open_per_contact forbids. The caller is
 * pointed at the thread that already holds the slot instead of being handed a
 * 500 from the raw P2002.
 */
export type SetConversationStatusResult =
  | { ok: true }
  | { ok: false; reason: "NOT_FOUND" }
  | { ok: false; reason: "ANOTHER_THREAD_OPEN"; openConversationId: string | null }

/** The other open thread for this contact, if any. */
async function otherOpenThreadId(tenantId: string, contactId: string, exceptId: string): Promise<string | null> {
  const other = await prisma.conversation.findFirst({
    where: { tenantId, contactId, closedAt: null, id: { not: exceptId } },
    select: { id: true },
  })
  return other?.id ?? null
}

export async function setConversationStatus(a: {
  tenantId: string; conversationId: string
  status: "OPEN" | "CLOSED" | "PENDING_CUSTOMER" | "PENDING_INTERNAL"
  actorUserId: string; actorEmail?: string; now?: Date
}): Promise<SetConversationStatusResult> {
  // Every non-CLOSED status clears closedAt, so any of them can REOPEN a closed
  // thread — and the contact may have picked up a new open thread since. Check
  // before writing; the P2002 catch below covers the TOCTOU gap.
  const reopening = a.status !== "CLOSED"
  let contactId: string | null = null
  if (reopening) {
    const target = await prisma.conversation.findFirst({
      where: { id: a.conversationId, tenantId: a.tenantId },
      select: { contactId: true, closedAt: true },
    })
    if (!target) return { ok: false, reason: "NOT_FOUND" }
    contactId = target.contactId
    if (target.closedAt !== null) {
      const openId = await otherOpenThreadId(a.tenantId, target.contactId, a.conversationId)
      if (openId !== null) return { ok: false, reason: "ANOTHER_THREAD_OPEN", openConversationId: openId }
    }
  }

  let res: { count: number }
  try {
    res = await prisma.conversation.updateMany({
      where: { id: a.conversationId, tenantId: a.tenantId },
      data: { status: a.status, closedAt: a.status === "CLOSED" ? (a.now ?? new Date()) : null },
    })
  } catch (err) {
    if (!isOneOpenPerContactConflict(err)) throw err
    return {
      ok: false,
      reason: "ANOTHER_THREAD_OPEN",
      openConversationId: contactId === null ? null : await otherOpenThreadId(a.tenantId, contactId, a.conversationId),
    }
  }
  if (res.count === 0) return { ok: false, reason: "NOT_FOUND" }
  await logAudit({
    tenantId: a.tenantId, userId: a.actorUserId, userEmail: a.actorEmail,
    action: "CONVERSATION_STATUS_CHANGED", entity: "Conversation", entityId: a.conversationId,
    newValue: { status: a.status },
  })
  return { ok: true }
}

export async function setConversationPriority(a: {
  tenantId: string; conversationId: string; priority: "NORMAL" | "HIGH" | "URGENT"
  actorUserId: string; actorEmail?: string
}): Promise<{ ok: boolean }> {
  const res = await prisma.conversation.updateMany({
    where: { id: a.conversationId, tenantId: a.tenantId },
    data: { priority: a.priority },
  })
  if (res.count === 0) return { ok: false }
  await logAudit({
    tenantId: a.tenantId, userId: a.actorUserId, userEmail: a.actorEmail,
    action: "CONVERSATION_PRIORITY_CHANGED", entity: "Conversation", entityId: a.conversationId,
    newValue: { priority: a.priority },
  })
  return { ok: true }
}
