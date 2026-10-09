import { Prisma, type Message } from "@prisma/client"
import { logAuditStrict } from "@/lib/audit"
import { getLenderBrandName } from "@/lib/config/identity"
import { prisma } from "@/lib/prisma"
import { MAX_STAFF_REPLY_CHARS, presenceLine, staffFirstName } from "./constants"
import { stampThread, utc, type Tx } from "./rows"

/** A line typed by staff: the author is what tells it apart from the bot's rows. */
async function writeStaffLine(tx: Tx, a: { tenantId: string; conversationId: string; staffUserId: string; text: string; now: Date; idempotencyKey?: string }): Promise<Message> {
  const message = await tx.message.create({
    data: {
      tenantId: a.tenantId, conversationId: a.conversationId, channel: "CHATBOT", direction: "OUTBOUND", provider: "MANUAL",
      createdById: a.staffUserId, status: "DELIVERED", sentAt: a.now, deliveredAt: a.now, bodyText: a.text, idempotencyKey: a.idempotencyKey,
    },
  })
  await stampThread(tx, { ...a, direction: "outbound", at: a.now })
  return message
}

/**
 * The name the visitor sees. Only a user of this tenant is named: an id from anywhere
 * else gets the neutral wording, so no other tenant's staff name reaches this transcript.
 */
async function nameShown(tx: Tx, tenantId: string, staffUserId: string): Promise<string> {
  const staff = await tx.user.findFirst({ where: { id: staffUserId, tenantId }, select: { name: true } })
  return staffFirstName(staff?.name)
}

/**
 * The brand a presence line names: the tenant's brand name (its identity's
 * trading name, which the widget matches the line against), else the tenant's
 * own name. Never throws for an unconfigured identity, so the idle-release
 * sweep still releases chats.
 */
async function brandOf(tx: Tx, tenantId: string): Promise<string> {
  return getLenderBrandName(tenantId, tx as unknown as Parameters<typeof getLenderBrandName>[1])
}

/**
 * A staff member takes a website chat. The assignee is set by a conditional UPDATE on
 * the thread row: of several people joining at once only one matches, and the row lock
 * it takes is what the bot's reply and the hand-off time-out wait on. The line telling
 * the visitor a person has joined and the audit row commit with it, or not at all.
 *
 * Joining answers the hand-off: the chat goes back to OPEN (off the unanswered badge),
 * its hand-off row is deleted (nothing left to time out or email) and the bell items
 * that asked for a person are marked read for everyone.
 */
export async function joinChat(a: {
  tenantId: string; conversationId: string; staffUserId: string; staffEmail?: string; now: Date
}): Promise<{ ok: true } | { ok: false; reason: "ALREADY_CLAIMED" | "NOT_FOUND" }> {
  const { tenantId, conversationId, staffUserId } = a
  return prisma.$transaction(async (tx) => {
    const { count } = await tx.conversation.updateMany({
      where: { id: conversationId, tenantId, channel: "CHATBOT", assigneeId: null, closedAt: null },
      data: { assigneeId: staffUserId, status: "OPEN" },
    })
    if (count === 0) {
      const taken = await tx.conversation.findFirst({
        where: { id: conversationId, tenantId, channel: "CHATBOT", assigneeId: { not: null } }, select: { id: true },
      })
      return { ok: false, reason: taken ? "ALREADY_CLAIMED" : "NOT_FOUND" }
    }
    await tx.websiteChatHandoff.deleteMany({ where: { conversationId, tenantId } })
    await tx.notification.updateMany({ where: { tenantId, type: "CHAT_HANDOFF", entityId: conversationId, readAt: null }, data: { readAt: a.now } })
    await writeStaffLine(tx, { ...a, text: presenceLine(await nameShown(tx, tenantId, staffUserId), "joined", await brandOf(tx, tenantId)) })
    await logAuditStrict({
      tenantId, userId: staffUserId, userEmail: a.staffEmail,
      action: "WEBSITE_CHAT_STAFF_JOINED", entity: "Conversation", entityId: conversationId,
      newValue: { assigneeId: staffUserId },
    }, tx)
    return { ok: true }
  })
}

/**
 * Hands the chat back to the assistant and tells the visitor, in the name of the person who held it.
 * An open chat goes back to OPEN whatever its holder set it to: left pending by hand it would have no
 * wait for anyone to answer, and the assistant could never hand it off again. The caller holds the thread row lock.
 */
async function release(tx: Tx, a: { tenantId: string; conversationId: string; assigneeId: string; closed: boolean; now: Date }): Promise<void> {
  await tx.conversation.update({ where: { id: a.conversationId, tenantId: a.tenantId }, data: { assigneeId: null, ...(a.closed ? {} : { status: "OPEN" }) } })
  const name = await nameShown(tx, a.tenantId, a.assigneeId)
  await writeStaffLine(tx, { ...a, staffUserId: a.assigneeId, text: presenceLine(name, "left", await brandOf(tx, a.tenantId)) })
}

/**
 * The staff member who joined hands the chat back to the assistant; `asAdmin` lets the
 * caller release a chat a colleague holds (one who walked away). A takeover is always
 * visible in the stored transcript, so the visitor is told in the same transaction that
 * clears the assignee: the line names, and is authored by, the person who held the chat,
 * and the audit row names the caller. An open chat goes back to OPEN and has no hand-off
 * row (the join deleted it), so a later hand-off by the assistant starts afresh. A closed
 * chat can still be left, and stays closed.
 */
export async function leaveChat(a: {
  tenantId: string; conversationId: string; staffUserId: string; staffEmail?: string; asAdmin?: boolean; now: Date
}): Promise<{ ok: true } | { ok: false; reason: "NOT_ASSIGNED_TO_YOU" }> {
  const { tenantId, conversationId, staffUserId } = a
  return prisma.$transaction(async (tx) => {
    const [thread] = await tx.$queryRaw<{ assigneeId: string | null; closedAt: Date | null }[]>`SELECT "assigneeId", "closedAt" FROM "Conversation" WHERE id = ${conversationId} AND "tenantId" = ${tenantId} AND channel = 'CHATBOT' FOR UPDATE`
    const assigneeId = thread?.assigneeId
    if (!assigneeId || (assigneeId !== staffUserId && !a.asAdmin)) return { ok: false, reason: "NOT_ASSIGNED_TO_YOU" }
    await release(tx, { tenantId, conversationId, assigneeId, closed: thread.closedAt !== null, now: a.now })
    await logAuditStrict({
      tenantId, userId: staffUserId, userEmail: a.staffEmail,
      action: "WEBSITE_CHAT_STAFF_LEFT", entity: "Conversation", entityId: conversationId,
      oldValue: { assigneeId }, newValue: { assigneeId: null },
    }, tx)
    return { ok: true }
  })
}

/** How long a visitor may wait on the staff member holding the chat before it goes back to the assistant. */
export const STAFF_IDLE_RELEASE_MS = 10 * 60 * 1000
/** Per tenant per run, longest-waiting first; the next minute takes the rest. */
const RELEASE_BATCH = 100

/**
 * Hands back every chat a staff member holds whose visitor wrote last and has been
 * waiting 10 minutes: the person went home, was deactivated, or lost the tab. Released
 * exactly as a leave (same line, in that person's name), with no acting user in the
 * audit row. The rule is checked again under the thread row lock, so a reply or a
 * close that lands after the read keeps the chat as it is.
 */
export async function releaseIdleChats(tenantId: string, now: Date): Promise<number> {
  const abandoned = Prisma.sql`"tenantId" = ${tenantId} AND channel = 'CHATBOT' AND "assigneeId" IS NOT NULL AND "closedAt" IS NULL
    AND "lastInboundAt" <= ${utc(new Date(now.getTime() - STAFF_IDLE_RELEASE_MS))} AND ("lastOutboundAt" IS NULL OR "lastInboundAt" > "lastOutboundAt")`
  const idle = await prisma.$queryRaw<{ id: string }[]>`SELECT id FROM "Conversation" WHERE ${abandoned} ORDER BY "lastInboundAt" ASC LIMIT ${RELEASE_BATCH}`
  let released = 0
  for (const { id: conversationId } of idle) {
    released += await prisma.$transaction(async (tx) => {
      const [thread] = await tx.$queryRaw<{ assigneeId: string }[]>`SELECT "assigneeId" FROM "Conversation" WHERE id = ${conversationId} AND ${abandoned} FOR UPDATE`
      if (!thread) return 0
      await release(tx, { tenantId, conversationId, assigneeId: thread.assigneeId, closed: false, now })
      await logAuditStrict({
        tenantId, action: "WEBSITE_CHAT_STAFF_AUTO_RELEASED", entity: "Conversation", entityId: conversationId,
        oldValue: { assigneeId: thread.assigneeId }, newValue: { assigneeId: null },
      }, tx)
      return 1
    })
  }
  return released
}

type StaffReplyResult = { ok: true; message: Message } | { ok: false; reason: "NOT_JOINED" | "CLOSED" | "CONVERSATION_NOT_FOUND" | "TOO_LONG" | "EMPTY" }

/**
 * A reply typed by the staff member who joined, shown to the visitor in the chat window.
 * Nothing leaves the system, so the row is delivered as soon as it is stored. The thread
 * row is locked first so a close or a change of assignee cannot slip in before the write.
 *
 * A retry carrying the same idempotencyKey gets the reply already stored for this chat,
 * even if the chat was closed or released since: that reply was delivered. Every write
 * with one key is on one chat and waits on its row lock, so the lookup cannot race; the
 * unique (tenantId, idempotencyKey) index on Message refuses a key reused on another chat.
 */
export async function sendStaffChatReply(a: {
  tenantId: string; conversationId: string; staffUserId: string; staffEmail?: string; text: string; now: Date; idempotencyKey?: string
}): Promise<StaffReplyResult> {
  const { tenantId, conversationId, staffUserId, idempotencyKey } = a
  if (a.text.trim() === "") return { ok: false, reason: "EMPTY" }
  if (a.text.length > MAX_STAFF_REPLY_CHARS) return { ok: false, reason: "TOO_LONG" }
  return prisma.$transaction(async (tx) => {
    const [thread] = await tx.$queryRaw<{ assigneeId: string | null; closedAt: Date | null }[]>`SELECT "assigneeId", "closedAt" FROM "Conversation" WHERE id = ${conversationId} AND "tenantId" = ${tenantId} AND channel = 'CHATBOT' FOR UPDATE`
    if (!thread) return { ok: false, reason: "CONVERSATION_NOT_FOUND" }
    const stored = idempotencyKey ? await tx.message.findFirst({ where: { tenantId, conversationId, idempotencyKey } }) : null
    if (stored) return { ok: true, message: stored }
    if (thread.closedAt) return { ok: false, reason: "CLOSED" }
    if (thread.assigneeId !== staffUserId) return { ok: false, reason: "NOT_JOINED" }
    const message = await writeStaffLine(tx, a)
    // The message id only: the text is the visitor's conversation, not audit evidence.
    await logAuditStrict({
      tenantId, userId: staffUserId, userEmail: a.staffEmail,
      action: "WEBSITE_CHAT_STAFF_REPLY", entity: "Conversation", entityId: conversationId,
      newValue: { messageId: message.id },
    }, tx)
    return { ok: true, message }
  })
}
