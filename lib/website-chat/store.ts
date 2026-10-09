import { prisma } from "@/lib/prisma"
import { DAILY_BOT_REPLY_CAP, MAX_VISITOR_MESSAGES, MAX_VISITOR_MESSAGES_WITH_STAFF, staffFirstName } from "./constants"
import { handoffLine, withHandoffLine } from "./handoff-line"
import { isBusinessOpen } from "./hours"
import { countTodaysVisitorMessages } from "./limits"
import { chatMode, type ChatLine, type ChatMode } from "./mode"
import { HANDOFF_REASON_TEXT, type ChatTurn, type HandoffReason } from "./model"
import { parseChatRef } from "./ref"
import { CHAT, LEAD_LINK, note, stampThread, type Tx } from "./rows"

// Opening a chat lives in start.ts; re-exported so callers keep one import for the chat's rows.
export { startChat } from "./start"

export type LoadedChat = {
  id: string; closed: boolean; handedOff: boolean; mode: ChatMode; staffFirstName: string | null; ref: string | null
  turns: ChatTurn[]; lines: ChatLine[]
}

export async function loadChat(tenantId: string, conversationId: string): Promise<LoadedChat | null> {
  const cv = await prisma.conversation.findFirst({
    where: { id: conversationId, tenantId, channel: CHAT.channel },
    select: {
      id: true, closedAt: true, status: true, subject: true, assigneeId: true,
      assignee: { select: { name: true } },
      websiteChatHandoff: { select: { timedOutAt: true } },
      messages: {
        where: { channel: CHAT.channel, direction: { in: ["INBOUND", "OUTBOUND"] } },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: { id: true, direction: true, provider: true, bodyText: true, createdById: true, createdBy: { select: { name: true, tenantId: true } } },
      },
    },
  })
  if (!cv) return null
  // An OUTBOUND row with an author was typed by staff; the bot's rows have none. A staff line carries its
  // own author's first name, so it stays theirs after a handover; only a user of this tenant is named.
  const lines: ChatLine[] = cv.messages.map((m) => {
    const line = { id: m.id, text: m.bodyText ?? "" }
    if (m.direction === "INBOUND") return { ...line, from: "visitor" }
    if (!m.createdById) return { ...line, from: "assistant" }
    return { ...line, from: "staff", name: staffFirstName(m.createdBy?.tenantId === tenantId ? m.createdBy.name : null, "Consultant") }
  })
  const mode = chatMode(cv, cv.websiteChatHandoff)
  return {
    id: cv.id, closed: cv.closedAt !== null, handedOff: cv.status === "PENDING_INTERNAL", mode,
    staffFirstName: mode === "staff" ? staffFirstName(cv.assignee?.name) : null,
    ref: parseChatRef(cv.subject),
    // Only the assistant's own conversation goes back to the model: the visitor's messages it was
    // asked (provider CHATBOT) and its replies (no author). Nothing from staff mode is sent: not the
    // visitor's messages to staff (MANUAL), staff lines, or the join and leave lines.
    turns: cv.messages.flatMap((m, i): ChatTurn[] => {
      if (m.direction === "INBOUND") return m.provider === "CHATBOT" ? [{ role: "visitor", text: lines[i].text }] : []
      return m.createdById ? [] : [{ role: "assistant", text: lines[i].text }]
    }),
    lines,
  }
}

export type VisitorMessageResult =
  | { accepted: true }
  /** Refused for a cap: never sent to the model, kept for staff unless their cap is reached too. */
  | { accepted: false; reason: "daily_cap" | "conversation_cap"; stored: boolean }
  /** The chat was closed before this message got the row lock: nothing is written. */
  | { accepted: false; reason: "closed" }
  /**
   * Kept for staff (unless their cap is reached), never sent to the model: staff hold the chat or
   * are being waited for, or it is in the fallback past the assistant's own cap.
   */
  | { accepted: false; reason: "to_staff"; stored: boolean }

type NewMessage = { tenantId: string; conversationId: string; text: string; now: Date }
type LockedThread = { status: string; assigneeId: string | null; closedAt: Date | null }

/** The chat's mode as of now. The caller holds the thread row lock, which every change of mode takes first. */
async function lockedMode(tx: Tx, a: { tenantId: string; conversationId: string }, thread: LockedThread): Promise<ChatMode> {
  const handoff = await tx.websiteChatHandoff.findFirst({ where: { conversationId: a.conversationId, tenantId: a.tenantId }, select: { timedOutAt: true } })
  return chatMode(thread, handoff)
}

/**
 * Keeps a visitor message for staff, up to the staff-mode cap. The caller holds the thread row lock.
 * Stored as MANUAL: no model call is made for it, so the daily model cap (limits.ts) must not count it.
 */
async function storeForStaff(tx: Tx, a: NewMessage): Promise<boolean> {
  const sent = await tx.message.count({ where: { tenantId: a.tenantId, conversationId: a.conversationId, channel: CHAT.channel, direction: "INBOUND" } })
  if (sent >= MAX_VISITOR_MESSAGES_WITH_STAFF) return false
  await tx.message.create({
    data: { tenantId: a.tenantId, conversationId: a.conversationId, channel: CHAT.channel, provider: "MANUAL", direction: "INBOUND", status: "DELIVERED", deliveredAt: a.now, bodyText: a.text },
    select: { id: true },
  })
  await stampThread(tx, { ...a, direction: "inbound", at: a.now })
  return true
}

/**
 * Stores the visitor's message for the assistant unless the tenant's daily cap or this
 * chat's cap is reached. Lock order, always: the tenant's daily advisory lock, then the
 * thread row. The daily lock serialises every chat of the tenant, so a burst across
 * fresh chats cannot all see "one call left"; the row lock does the same for one chat.
 *
 * A visitor message is never silently dropped. One refused for a cap is not sent to the
 * model but kept for staff (storeForStaff: MANUAL, bounded by the staff-mode cap), in
 * any mode; the caller opens the hand-off. Only a closed chat, or the staff-mode cap,
 * keeps nothing, and the caller says so.
 *
 * The caller's view of the mode is an unlocked read, so it is decided again here under
 * the row lock: if staff took the chat or a hand-off opened meanwhile, the message is
 * kept for staff and the caller must not send it to the model. A chat closed meanwhile
 * takes no message at all.
 */
export async function recordVisitorMessage(a: NewMessage): Promise<VisitorMessageResult> {
  return prisma.$transaction(async (tx) => {
    // $executeRaw, not $queryRaw: the lock function returns void, which $queryRaw cannot deserialise.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${a.tenantId} || ':webchat-day'))`
    const [thread] = await tx.$queryRaw<LockedThread[]>`SELECT status, "assigneeId", "closedAt" FROM "Conversation" WHERE id = ${a.conversationId} AND "tenantId" = ${a.tenantId} FOR UPDATE`
    if (thread?.closedAt) return { accepted: false, reason: "closed" }
    const mode = thread ? await lockedMode(tx, a, thread) : null
    if (mode === "waiting" || mode === "staff") return { accepted: false, reason: "to_staff", stored: await storeForStaff(tx, a) }
    const dailyCapReached = (await countTodaysVisitorMessages(tx, a.tenantId, a.now)) >= DAILY_BOT_REPLY_CAP
    // Only the messages the assistant was asked: those kept for staff (MANUAL) have their own cap.
    const sent = await tx.message.count({ where: { tenantId: a.tenantId, conversationId: a.conversationId, ...CHAT, direction: "INBOUND" } })
    const cap = sent >= MAX_VISITOR_MESSAGES ? "conversation_cap" : dailyCapReached ? "daily_cap" : null
    if (cap) {
      const stored = await storeForStaff(tx, a)
      // Already handed off (the fallback): nothing to open, the message is simply for staff.
      return mode === "fallback" ? { accepted: false, reason: "to_staff", stored } : { accepted: false, reason: cap, stored }
    }
    await tx.message.create({
      data: { tenantId: a.tenantId, conversationId: a.conversationId, ...CHAT, direction: "INBOUND", status: "DELIVERED", deliveredAt: a.now, bodyText: a.text },
      select: { id: true },
    })
    await stampThread(tx, { ...a, direction: "inbound", at: a.now })
    return { accepted: true }
  })
}

/**
 * A visitor message while staff hold the chat: no model call, so neither the tenant's
 * daily lock nor the daily cap applies. The thread row lock still serialises one chat
 * so a burst cannot pass its cap.
 */
export async function recordVisitorMessageToStaff(a: NewMessage): Promise<{ accepted: true } | { accepted: false; reason: "closed" | "staff_cap" | "not_staff" }> {
  return prisma.$transaction(async (tx) => {
    const [thread] = await tx.$queryRaw<LockedThread[]>`SELECT status, "assigneeId", "closedAt" FROM "Conversation" WHERE id = ${a.conversationId} AND "tenantId" = ${a.tenantId} FOR UPDATE`
    if (!thread || thread.closedAt) return { accepted: false, reason: "closed" }
    // The caller's view of the mode is an unlocked read: staff may have handed the chat back since.
    // Then nothing is written here and the caller takes the message down the assistant's path.
    const mode = await lockedMode(tx, a, thread)
    if (mode !== "waiting" && mode !== "staff") return { accepted: false, reason: "not_staff" }
    return (await storeForStaff(tx, a)) ? { accepted: true } : { accepted: false, reason: "staff_cap" }
  })
}

/** The visitor's self-declared details from the Lead named in the chat's first note (the chat Contact carries no number). */
export async function visitorLead(tx: Tx, tenantId: string, conversationId: string): Promise<{ firstName: string; lastName: string; phone: string } | null> {
  const first = await tx.message.findFirst({
    where: { tenantId, conversationId, direction: "INTERNAL_NOTE" }, orderBy: { createdAt: "asc" }, select: { bodyText: true },
  })
  const leadId = first?.bodyText?.split(LEAD_LINK)[1]?.split(/\s/)[0]
  if (!leadId) return null
  return tx.lead.findFirst({ where: { id: leadId, tenantId }, select: { firstName: true, lastName: true, phone: true } })
}

/**
 * Opens the wait for staff in the transaction that flips the status, so a pending chat is
 * never without its row: a poll or a second message right after the flip sees the wait.
 * After hours (`open` false) the row is born timed out. A later hand-off on the same chat resets it.
 */
async function openHandoff(tx: Tx, a: { tenantId: string; conversationId: string; now: Date }, open: boolean): Promise<"waiting" | "fallback"> {
  const fresh = { handedOffAt: a.now, timedOutAt: open ? null : a.now, alertEmailSentAt: null, alertAttempts: 0 }
  await tx.websiteChatHandoff.upsert({
    where: { conversationId: a.conversationId, tenantId: a.tenantId },
    create: { ...fresh, tenant: { connect: { id: a.tenantId } }, conversation: { connect: { id: a.conversationId, tenantId: a.tenantId } } },
    update: fresh,
  })
  return open ? "waiting" : "fallback"
}

/** `mode` comes only with the call that handed the chat off: what the visitor is left with. `reply` is what was written. */
export type AssistantReplyResult =
  | { handedOffNow: false; suppressed: true }
  | { handedOffNow: false; suppressed: false; reply: string }
  | { handedOffNow: true; suppressed: false; mode: "waiting" | "fallback"; reply: string }

/**
 * Writes the assistant's reply. For a hand-off, `reply` is only the model's own text (it may be
 * empty) and the line saying what happens next is added here (handoff-line.ts), from the same
 * business-hours check, at the same instant, that decides whether the hand-off waits for staff
 * or falls back: the line and the widget's mode cannot disagree.
 *
 * `handoffOnly`: the reply is a hand-off notice and nothing else (a cap refused the message), so it
 * is written only by the call that opens the hand-off; any other call writes nothing (suppressed).
 */
export async function recordAssistantReply(a: {
  tenantId: string; conversationId: string; reply: string; needsHuman: boolean; reason: HandoffReason | null; now: Date; handoffOnly?: boolean
}): Promise<AssistantReplyResult> {
  return prisma.$transaction(async (tx) => {
    // The model call takes seconds; staff can join, or another request can hand the chat off,
    // during it. Under the row lock either is committed (seen here) or waits for this write:
    // the bot never writes into a chat that staff hold or that is waiting for them.
    const [thread] = await tx.$queryRaw<LockedThread[]>`SELECT status, "assigneeId", "closedAt" FROM "Conversation" WHERE id = ${a.conversationId} AND "tenantId" = ${a.tenantId} FOR UPDATE`
    if (!thread) return { handedOffNow: false, suppressed: true }
    const mode = await lockedMode(tx, a, thread)
    if (mode === "waiting" || mode === "staff" || mode === "ended") return { handedOffNow: false, suppressed: true }
    // Conditional flip: of two concurrent hand-offs only one matches, so only one note is written.
    // It fails only for a chat already handed off and in the fallback, which stays there.
    const handedOffNow = a.needsHuman && (await tx.conversation.updateMany({
      where: { id: a.conversationId, tenantId: a.tenantId, status: { not: "PENDING_INTERNAL" }, closedAt: null },
      data: { status: "PENDING_INTERNAL", priority: "HIGH" },
    })).count === 1
    if (a.handoffOnly && !handedOffNow) return { handedOffNow: false, suppressed: true }
    let reply = a.reply
    let open = false
    if (a.needsHuman) {
      // Read-only on purpose: getCommsSettings upserts, and an anonymous visitor triggers this.
      const businessHours = (await tx.commsSettings.findUnique({ where: { tenantId: a.tenantId }, select: { businessHours: true } }))?.businessHours
      // One hours check: it decides the mode (a wait only for a hand-off opened now, in hours) and the line.
      const inHours = isBusinessOpen(businessHours, a.now)
      open = handedOffNow && inHours
      reply = withHandoffLine(a.reply, handoffLine(a.reason, open ? "waiting" : "fallback", inHours, businessHours))
    }
    await tx.message.create({
      data: { tenantId: a.tenantId, conversationId: a.conversationId, ...CHAT, direction: "OUTBOUND", status: "DELIVERED", sentAt: a.now, deliveredAt: a.now, bodyText: reply },
      select: { id: true },
    })
    await stampThread(tx, { ...a, direction: "outbound", at: a.now })
    if (!handedOffNow) return { handedOffNow: false, suppressed: false, reply }
    const phone = (await visitorLead(tx, a.tenantId, a.conversationId))?.phone
    const callBack = phone ? `Call the visitor on +${phone}.` : "Call the visitor on the number in the first note."
    await tx.message.create({
      data: note(a.tenantId, a.conversationId, `Needs human: ${HANDOFF_REASON_TEXT[a.reason ?? "out_of_scope"]}. ${callBack}`),
      select: { id: true },
    })
    return { handedOffNow: true, suppressed: false, mode: await openHandoff(tx, a, open), reply }
  })
}
