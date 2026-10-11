import { Prisma } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { computeWaWindow } from "./window"
import { matchesQueue } from "./queue-membership"
import { contactReplyChannels } from "./reply-channels"

export { matchesQueue }

export type InboxQueue = "unassigned" | "mine" | "all" | "closed"

export type ConversationSummary = {
  id: string
  /**
   * Channel of the newest customer-facing message, else Conversation.channel.
   * One thread carries every channel, and Conversation.channel only records
   * the one it was OPENED on — badging that labels a WhatsApp reminder EMAIL.
   */
  channel: string
  status: string
  priority: string
  subject: string | null
  assigneeId: string | null
  assigneeName: string | null
  contactId: string
  contactName: string
  contactStatus: string
  primaryPhone: string | null
  primaryWaJid: string | null
  lastMessagePreview: string | null
  lastMessageAt: string | null
  lastInboundAt: string | null
  lastActivityAt: string | null
  unreadCount: number
  updatedAt: string
}

const DEFAULT_LIMIT = 30

function displayName(c: { firstName: string | null; lastName: string | null; primaryPhone: string | null }): string {
  const name = [c.firstName, c.lastName].filter((s) => s !== null && s !== "").join(" ")
  return name !== "" ? name : (c.primaryPhone ?? "Unknown")
}

// queueWhere (Prisma filter) and matchesQueue (in-memory predicate, in
// ./queue-membership) encode the same per-queue membership rule in two
// execution contexts — keep them in sync branch-for-branch when either
// changes. matchesQueue is exhaustively tested in conversations.test.ts as
// the drift guard.
function queueWhere(queue: InboxQueue, tenantId: string, agentUserId: string) {
  if (queue === "closed") return { tenantId, status: "CLOSED" as const }
  const base = { tenantId, status: { not: "CLOSED" as const } }
  if (queue === "unassigned") return { ...base, assigneeId: null }
  if (queue === "mine") return { ...base, assigneeId: agentUserId }
  return base
}

// Cheap lookup so a deep link (?conversationId=) can pick the right queue
// tab server-side before the full conversation list loads. Returns null if
// the conversation doesn't exist in this tenant (deep link ignored).
export async function resolveQueueForConversation(args: {
  tenantId: string
  conversationId: string
  agentUserId: string
}): Promise<InboxQueue | null> {
  const cv = await prisma.conversation.findFirst({
    where: { id: args.conversationId, tenantId: args.tenantId },
    select: { status: true, assigneeId: true },
  })
  if (!cv) return null
  if (cv.status === "CLOSED") return "closed"
  if (cv.assigneeId === null) return "unassigned"
  if (cv.assigneeId === args.agentUserId) return "mine"
  return "all"
}

const SUMMARY_INCLUDE = {
  assignee: { select: { name: true } },
  contact: { select: { firstName: true, lastName: true, primaryPhone: true, primaryWaJid: true, status: true } },
  messages: { take: 1, orderBy: { createdAt: "desc" as const }, select: { bodyText: true, createdAt: true, deletedAt: true } },
}

type ConversationRow = {
  id: string; channel: string; status: string; priority: string; subject: string | null
  assigneeId: string | null; contactId: string
  assignee: { name: string | null } | null
  contact: { firstName: string | null; lastName: string | null; primaryPhone: string | null; primaryWaJid: string | null; status: string }
  messages: { bodyText: string | null; createdAt: Date; deletedAt: Date | null }[]
  lastInboundAt: Date | null; lastOutboundAt: Date | null; lastActivityAt: Date | null; updatedAt: Date; createdAt: Date
}

// Newest customer-facing message's channel per conversation. Internal notes
// are excluded: lib/inbox/notes.ts stamps them with Conversation.channel, so
// a note posted after a WhatsApp reminder would put the stale badge back.
// SIMULATED is excluded too: those rows were never sent (SMS is off by
// policy and nothing was delivered), so badging a thread SMS would claim a channel that never ran.
// Raw SQL for DISTINCT ON — Prisma's `distinct` loads every row into JS.
async function latestChannelByConversation(tenantId: string, ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map()
  const rows = await prisma.$queryRaw<{ conversationId: string; channel: string }[]>`
    SELECT DISTINCT ON ("conversationId") "conversationId", "channel"::text AS "channel"
    FROM "Message"
    WHERE "tenantId" = ${tenantId}
      AND "conversationId" IN (${Prisma.join(ids)})
      AND "isInternal" = false
      AND "direction" <> 'INTERNAL_NOTE'
      AND "status" <> 'SIMULATED'
    ORDER BY "conversationId", "createdAt" DESC
  `
  return new Map(rows.map((r) => [r.conversationId, r.channel]))
}

function toConversationSummary(r: ConversationRow, unreadCount: number, latestChannel: string | undefined): ConversationSummary {
  const latest = r.messages[0] ?? null
  const lastMessageAt = latest?.createdAt ?? r.lastInboundAt ?? r.lastOutboundAt ?? r.createdAt
  return {
    id: r.id,
    channel: latestChannel ?? r.channel,
    status: r.status,
    priority: r.priority,
    subject: r.subject,
    assigneeId: r.assigneeId,
    assigneeName: r.assignee?.name ?? null,
    contactId: r.contactId,
    contactName: displayName(r.contact),
    contactStatus: r.contact.status,
    primaryPhone: r.contact.primaryPhone,
    primaryWaJid: r.contact.primaryWaJid,
    // Same redaction as toThreadMessage, applied to the list-row DTO: a
    // soft-deleted newest message must not leak its body into the queue
    // preview even though it never passes through toThreadMessage. "Note
    // deleted" rather than null — null renders as an empty preview, which
    // reads as "this thread has no messages" and is itself a false claim.
    lastMessagePreview: latest?.deletedAt ? "Note deleted" : (latest?.bodyText ?? null),
    lastMessageAt: lastMessageAt ? lastMessageAt.toISOString() : null,
    lastInboundAt: r.lastInboundAt ? r.lastInboundAt.toISOString() : null,
    // The queue's sort key. Carried on the DTO because the client's poll-merge
    // re-sorts the list with compareConversations() and has no other way to
    // reproduce the server's ORDER BY.
    lastActivityAt: r.lastActivityAt ? r.lastActivityAt.toISOString() : null,
    unreadCount,
    updatedAt: r.updatedAt.toISOString(),
  }
}

export async function listConversations(args: {
  tenantId: string
  queue: InboxQueue
  agentUserId: string
  limit?: number
  cursor?: string
}): Promise<{ conversations: ConversationSummary[]; nextCursor: string | null }> {
  const limit = args.limit ?? DEFAULT_LIMIT
  const rows = await prisma.conversation.findMany({
    where: queueWhere(args.queue, args.tenantId, args.agentUserId),
    // lastActivityAt, NOT lastInboundAt: a thread that has only ever had
    // outbound traffic has lastInboundAt = null and sorted below every
    // conversation that ever got a reply, which could leave it permanently
    // past the first page. See lib/inbox/ordering.ts.
    // Mirrored by compareConversations() for the client's poll-merge. Change
    // both together or the list visibly reshuffles on the first delta tick.
    orderBy: [{ lastActivityAt: { sort: "desc", nulls: "last" } }, { id: "desc" }],
    take: limit,
    ...(args.cursor ? { cursor: { id: args.cursor }, skip: 1 } : {}),
    include: SUMMARY_INCLUDE,
  })

  const ids = rows.map((r) => r.id)
  const unread = ids.length
    ? await prisma.message.groupBy({
        by: ["conversationId"],
        where: { tenantId: args.tenantId, conversationId: { in: ids }, direction: "INBOUND", readAt: null },
        _count: { _all: true },
      })
    : []
  const unreadByConv = new Map(unread.map((u) => [u.conversationId, u._count._all]))
  const channelByConv = await latestChannelByConversation(args.tenantId, ids)

  const conversations = rows.map((r) => toConversationSummary(r, unreadByConv.get(r.id) ?? 0, channelByConv.get(r.id)))
  const nextCursor = rows.length === limit ? rows[rows.length - 1].id : null
  return { conversations, nextCursor }
}

// Fetches a single conversation in the same list-item shape as
// listConversations, tenant-scoped the same way. Used to pin a deep-linked
// conversation into the initial list when it exists but ranks beyond the
// queue's first page (DEFAULT_LIMIT, ordered by lastActivityAt desc).
export async function getConversationSummary(args: {
  tenantId: string
  conversationId: string
}): Promise<ConversationSummary | null> {
  const row = await prisma.conversation.findFirst({
    where: { id: args.conversationId, tenantId: args.tenantId },
    include: SUMMARY_INCLUDE,
  })
  if (!row) return null
  const unreadCount = await prisma.message.count({
    where: { tenantId: args.tenantId, conversationId: args.conversationId, direction: "INBOUND", readAt: null },
  })
  const channelByConv = await latestChannelByConversation(args.tenantId, [row.id])
  return toConversationSummary(row, unreadCount, channelByConv.get(row.id))
}

export type ThreadMessage = {
  id: string
  direction: string
  isInternal: boolean
  bodyText: string | null
  status: string
  provider: string
  channel: string
  hasMedia: boolean
  errorMessage: string | null
  errorClass: string | null
  dispatchState: string | null
  dispatchLeaseExpiresAt: string | null
  templateId: string | null
  createdById: string | null
  createdByName: string | null
  createdAt: string
  sentAt: string | null
  deliveredAt: string | null
  readAt: string | null
  editedAt: string | null
  deletedAt: string | null
  deletedByName: string | null
  /// Flat on purpose: the bubble highlights the `@label` runs and needs nothing
  /// else, so the Prisma `{ user: { name, email } }` shape is collapsed here
  /// rather than leaked into a client component's props. `email` is carried
  /// because the picker inserts `@email` for a staffer with no name — without it
  /// that mention could never be highlighted.
  mentions: { userId: string; name: string | null; email: string | null }[]
}

export type ThreadDTO = {
  conversation: {
    id: string; channel: string; status: string; priority: string; subject: string | null
    assigneeId: string | null; assigneeName: string | null
    lastInboundAt: string | null; lastOutboundAt: string | null; createdAt: string
  }
  contact: {
    id: string; firstName: string | null; lastName: string | null; displayName: string
    primaryPhone: string | null; primaryWaJid: string | null; primaryEmail: string | null
    status: string; clientId: string | null; leadId: string | null; waOptedOut: boolean
  }
  linked: {
    loan: { id: string; reference: string; status: string } | null
    application: { id: string; reference: string; status: string } | null
  }
  messages: ThreadMessage[]
  window: { open: boolean; expiresAt: string | null }
  /**
   * Per-reply channel choice. One thread now carries every channel, so the
   * composer needs to know which ones this contact can actually receive and
   * which to preselect. defaultChannel = the newest inbound message's channel.
   */
  reply: { availableChannels: Array<"WHATSAPP" | "EMAIL">; defaultChannel: string }
}

export function hasMedia(m: { documentRefs: unknown; attachmentsMeta: unknown }): boolean {
  const nonEmpty = (v: unknown) => v !== null && v !== undefined && (!Array.isArray(v) || v.length > 0)
  return nonEmpty(m.documentRefs) || nonEmpty(m.attachmentsMeta)
}

type MessageWithCreatedBy = {
  id: string; direction: string; isInternal: boolean; bodyText: string | null; status: string
  provider: string; channel: string; documentRefs: unknown; attachmentsMeta: unknown
  errorMessage: string | null; errorClass: string | null; dispatchState: string | null; dispatchLeaseExpiresAt: Date | null; templateId: string | null; createdById: string | null; createdBy: { name: string | null } | null
  createdAt: Date; sentAt: Date | null; deliveredAt: Date | null; readAt: Date | null
  editedAt: Date | null; deletedAt: Date | null; deletedBy: { name: string | null } | null
  mentions: { userId: string; user: { name: string | null; email: string | null } | null }[]
}

// Every place that loads thread messages needs this alongside createdBy/deletedBy,
// or the bubble silently renders every mention as plain text.
export const MESSAGE_THREAD_INCLUDE = {
  createdBy: { select: { name: true } },
  deletedBy: { select: { name: true } },
  mentions: { select: { userId: true, user: { select: { name: true, email: true } } } },
} as const

export function toThreadMessage(m: MessageWithCreatedBy): ThreadMessage {
  return {
    id: m.id, direction: m.direction, isInternal: m.isInternal,
    // Redaction lives here, not in the component: if the bubble did the hiding,
    // the deleted text would still ship inside the page payload.
    bodyText: m.deletedAt ? null : m.bodyText,
    status: m.status,
    provider: m.provider, channel: m.channel, hasMedia: hasMedia(m), errorMessage: m.errorMessage,
    errorClass: m.errorClass,
    dispatchState: m.dispatchState,
    dispatchLeaseExpiresAt: m.dispatchLeaseExpiresAt?.toISOString() ?? null,
    templateId: m.templateId,
    createdById: m.createdById, createdByName: m.createdBy?.name ?? null,
    createdAt: m.createdAt.toISOString(),
    sentAt: m.sentAt ? m.sentAt.toISOString() : null,
    deliveredAt: m.deliveredAt ? m.deliveredAt.toISOString() : null,
    readAt: m.readAt ? m.readAt.toISOString() : null,
    editedAt: m.editedAt ? m.editedAt.toISOString() : null,
    deletedAt: m.deletedAt ? m.deletedAt.toISOString() : null,
    deletedByName: m.deletedBy?.name ?? null,
    // Flattened at the DTO boundary, the same way createdByName and
    // deletedByName are. Not redacted with the body: who was tagged stays true
    // for a deleted note, and the bubble renders a tombstone with no body at
    // all in that case.
    mentions: m.mentions.map((x) => ({
      userId: x.userId,
      name: x.user?.name ?? null,
      email: x.user?.email ?? null,
    })),
  }
}

export async function getThread(args: {
  tenantId: string
  conversationId: string
  now?: Date
}): Promise<ThreadDTO | null> {
  const now = args.now ?? new Date()
  const cv = await prisma.conversation.findFirst({
    where: { id: args.conversationId, tenantId: args.tenantId },
    include: {
      assignee: { select: { name: true } },
      loan: { select: { id: true, reference: true, status: true } },
      application: { select: { id: true, reference: true, status: true } },
      contact: {
        select: {
          id: true, firstName: true, lastName: true, primaryPhone: true, primaryWaJid: true,
          primaryEmail: true, status: true, clientId: true, leadId: true, lastInboundAtByChannel: true,
        },
      },
      messages: {
        orderBy: { createdAt: "asc" },
        include: MESSAGE_THREAD_INCLUDE,
      },
    },
  })
  if (!cv) return null

  const revoked = await prisma.contactConsent.findFirst({
    where: { tenantId: args.tenantId, contactId: cv.contact.id, channel: "WHATSAPP", purpose: "SERVICE_COMMS", status: "REVOKED", effectiveTo: null },
    select: { id: true },
  })

  // Read the SAME field the sender reads (lib/whatsapp-cloud.ts). This used to
  // fall back to cv.lastInboundAt, which made the panel report "window open"
  // on conversations the sender would reject with WA_OUTSIDE_WINDOW_NEEDS_
  // TEMPLATE — the indicator has to be a claim about the send, not about the
  // thread.
  const waLast = (cv.contact.lastInboundAtByChannel as Record<string, string> | null)?.WHATSAPP ?? null
  const window = computeWaWindow(waLast ? new Date(waLast) : null, now)

  const availableChannels = cv.channel === "CHATBOT" ? [] : await contactReplyChannels(args.tenantId, cv.contact.id)
  // cv.messages is ordered createdAt asc — the last INBOUND is the newest.
  const lastInboundMessage = [...cv.messages].reverse().find((m) => m.direction === "INBOUND")
  const defaultChannel = lastInboundMessage?.channel ?? cv.channel

  const name = [cv.contact.firstName, cv.contact.lastName].filter((s) => s !== null && s !== "").join(" ")
  return {
    conversation: {
      id: cv.id, channel: cv.channel, status: cv.status, priority: cv.priority, subject: cv.subject,
      assigneeId: cv.assigneeId, assigneeName: cv.assignee?.name ?? null,
      lastInboundAt: cv.lastInboundAt ? cv.lastInboundAt.toISOString() : null,
      lastOutboundAt: cv.lastOutboundAt ? cv.lastOutboundAt.toISOString() : null,
      createdAt: cv.createdAt.toISOString(),
    },
    contact: {
      id: cv.contact.id, firstName: cv.contact.firstName, lastName: cv.contact.lastName,
      displayName: name !== "" ? name : (cv.contact.primaryPhone ?? cv.contact.primaryWaJid ?? "Unknown"),
      primaryPhone: cv.contact.primaryPhone, primaryWaJid: cv.contact.primaryWaJid, primaryEmail: cv.contact.primaryEmail,
      status: cv.contact.status, clientId: cv.contact.clientId, leadId: cv.contact.leadId,
      waOptedOut: revoked !== null,
    },
    linked: {
      loan: cv.loan ? { id: cv.loan.id, reference: cv.loan.reference, status: cv.loan.status } : null,
      application: cv.application ? { id: cv.application.id, reference: cv.application.reference, status: cv.application.status } : null,
    },
    messages: cv.messages.map(toThreadMessage),
    window: { open: window.open, expiresAt: window.expiresAt ? window.expiresAt.toISOString() : null },
    reply: { availableChannels: [...availableChannels], defaultChannel },
  }
}
