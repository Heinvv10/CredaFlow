/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $queryRaw: vi.fn(),
    conversation: { findMany: vi.fn(), findFirst: vi.fn() },
    message: { groupBy: vi.fn(), count: vi.fn() },
    contactConsent: { findFirst: vi.fn() },
  },
}))
vi.mock("./reply-channels", () => ({ contactReplyChannels: vi.fn() }))

import { listConversations, getThread, resolveQueueForConversation, getConversationSummary, matchesQueue, toThreadMessage } from "./conversations"
import { prisma } from "@/lib/prisma"
import { contactReplyChannels } from "./reply-channels"

beforeEach(() => {
  vi.clearAllMocks()
  // Default: contact reachable on nothing. Tests exercising availableChannels/
  // defaultChannel override this explicitly.
  vi.mocked(contactReplyChannels).mockResolvedValue([])
  // Default: no customer-facing messages, so the badge falls back to
  // Conversation.channel. Channel-badge tests override this.
  vi.mocked(prisma.$queryRaw).mockResolvedValue([] as never)
})

function convRow(over: any = {}) {
  return {
    id: "cv1",
    channel: "WHATSAPP",
    status: "OPEN",
    priority: "NORMAL",
    subject: null,
    assigneeId: null,
    assignee: null,
    contactId: "ct1",
    contact: { firstName: "Thabo", lastName: "M", primaryPhone: "27821234567", primaryWaJid: "27821234567@s.whatsapp.net", status: "UNKNOWN" },
    lastInboundAt: new Date("2026-07-05T10:00:00.000Z"),
    lastOutboundAt: null,
    lastActivityAt: new Date("2026-07-05T10:00:00.000Z"),
    updatedAt: new Date("2026-07-05T10:00:01.000Z"),
    createdAt: new Date("2026-07-05T09:00:00.000Z"),
    messages: [{ bodyText: "hello there", createdAt: new Date("2026-07-05T10:00:00.000Z"), direction: "INBOUND" }],
    ...over,
  }
}

describe("listConversations", () => {
  it("scopes the unassigned queue and maps summaries + unread counts", async () => {
    vi.mocked(prisma.conversation.findMany).mockResolvedValue([convRow()] as any)
    vi.mocked(prisma.message.groupBy).mockResolvedValue([{ conversationId: "cv1", _count: { _all: 3 } }] as any)

    const res = await listConversations({ tenantId: "t1", queue: "unassigned", agentUserId: "u1", limit: 25 })

    expect(prisma.conversation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId: "t1", status: { not: "CLOSED" }, assigneeId: null },
        take: 25,
        orderBy: [{ lastActivityAt: { sort: "desc", nulls: "last" } }, { id: "desc" }],
      }),
    )
    expect(res.conversations).toHaveLength(1)
    const s = res.conversations[0]
    expect(s.id).toBe("cv1")
    expect(s.contactName).toBe("Thabo M")
    expect(s.lastMessagePreview).toBe("hello there")
    expect(s.unreadCount).toBe(3)
    expect(s.assigneeName).toBeNull()
    expect(res.nextCursor).toBeNull() // fewer than `limit` rows
  })

  // Regression: toThreadMessage redacts a soft-deleted message's bodyText in
  // the thread pane, but toConversationSummary is a SECOND DTO mapper reading
  // the same underlying message row — it must redact independently or the
  // list beside the thread leaks the deleted text the pane just hid.
  it("redacts lastMessagePreview when the newest message is soft-deleted", async () => {
    vi.mocked(prisma.conversation.findMany).mockResolvedValue([
      convRow({ messages: [{ bodyText: "regrettable note", createdAt: new Date("2026-08-13T10:00:00Z"), deletedAt: new Date("2026-08-13T11:00:00Z") }] }),
    ] as any)
    vi.mocked(prisma.message.groupBy).mockResolvedValue([] as any)

    const res = await listConversations({ tenantId: "t1", queue: "all", agentUserId: "u1" })

    expect(res.conversations[0].lastMessagePreview).toBe("Note deleted")
    expect(res.conversations[0].lastMessagePreview).not.toContain("regrettable note")
  })

  // Regression guard the other way: a live (non-deleted) internal note is
  // pre-existing, deliberate behaviour on a staff-only surface and must keep
  // previewing normally — this must fail if the redaction is over-applied.
  it("still previews a non-deleted message's bodyText normally", async () => {
    vi.mocked(prisma.conversation.findMany).mockResolvedValue([
      convRow({ messages: [{ bodyText: "a live note", createdAt: new Date("2026-08-13T10:00:00Z"), deletedAt: null }] }),
    ] as any)
    vi.mocked(prisma.message.groupBy).mockResolvedValue([] as any)

    const res = await listConversations({ tenantId: "t1", queue: "all", agentUserId: "u1" })

    expect(res.conversations[0].lastMessagePreview).toBe("a live note")
  })

  // Regression, two layers deep.
  //
  // Layer 1: Postgres `ORDER BY x DESC` puts NULLs FIRST by default, so
  // outbound-only conversations (lastInboundAt = NULL) sorted ahead of the
  // genuine inbound ones and pushed them off the first page.
  // `nulls: "last"` fixed that.
  //
  // Layer 2 (THIS defect): NULLS LAST then buried the OTHER side —
  // an outbound-only thread has lastInboundAt = NULL forever, so it ranked
  // below every conversation that ever got a reply, however stale, and could
  // sit invisible past the 30-row first page. The sort key is now lastActivityAt = GREATEST(lastInboundAt,
  // lastOutboundAt), which has a value for both populations.
  //
  // A mocked Prisma can't execute real ordering, so this asserts the query
  // shape sent to findMany, not the resulting row order. The row order itself
  // is proved in conversation-last-activity.integration.test.ts against a
  // real database.
  it("orders by lastActivityAt NULLS LAST so neither an outbound-only nor an inbound-only conversation is buried", async () => {
    vi.mocked(prisma.conversation.findMany).mockResolvedValue([] as any)
    vi.mocked(prisma.message.groupBy).mockResolvedValue([] as any)
    await listConversations({ tenantId: "t1", queue: "unassigned", agentUserId: "u1" })
    const arg = vi.mocked(prisma.conversation.findMany).mock.calls[0][0] as any
    expect(arg.orderBy).toEqual([{ lastActivityAt: { sort: "desc", nulls: "last" } }, { id: "desc" }])
    // The sort key must NOT be lastInboundAt any more — that is the defect.
    expect(JSON.stringify(arg.orderBy)).not.toContain("lastInboundAt")
  })

  // The queue's sort key has to reach the browser: InboxClient re-sorts the
  // merged list with compareConversations() on every 4s delta tick, and can
  // only do that from the DTO.
  it("carries lastActivityAt on the summary DTO for the client's poll-merge", async () => {
    vi.mocked(prisma.conversation.findMany).mockResolvedValue([
      convRow({ lastActivityAt: new Date("2026-08-19T08:00:00.000Z") }),
    ] as any)
    vi.mocked(prisma.message.groupBy).mockResolvedValue([] as any)
    const res = await listConversations({ tenantId: "t1", queue: "all", agentUserId: "u1" })
    expect(res.conversations[0].lastActivityAt).toBe("2026-08-19T08:00:00.000Z")
  })

  // BADGE NON-REGRESSION. The unread badge is a claim about INBOUND messages
  // an agent has not opened. It must keep filtering on direction INBOUND +
  // readAt null, and must NOT drift to lastActivityAt just because the sort
  // key did — outbound we sent ourselves is never "unread".
  it("still counts only unread INBOUND messages for the badge", async () => {
    vi.mocked(prisma.conversation.findMany).mockResolvedValue([convRow()] as any)
    vi.mocked(prisma.message.groupBy).mockResolvedValue([{ conversationId: "cv1", _count: { _all: 4 } }] as any)
    const res = await listConversations({ tenantId: "t1", queue: "all", agentUserId: "u1" })
    const groupArg = vi.mocked(prisma.message.groupBy).mock.calls[0][0] as any
    expect(groupArg.where).toEqual({
      tenantId: "t1",
      conversationId: { in: ["cv1"] },
      direction: "INBOUND",
      readAt: null,
    })
    expect(res.conversations[0].unreadCount).toBe(4)
  })

  // An outbound-only conversation has no inbound at all, so its badge is 0
  // even though it now sorts at the top. Sorting it up must not invent unread.
  it("shows a zero badge on an outbound-only conversation that sorts to the top", async () => {
    vi.mocked(prisma.conversation.findMany).mockResolvedValue([
      convRow({
        id: "outbound-only",
        lastInboundAt: null,
        lastOutboundAt: new Date("2026-08-19T08:00:00.000Z"),
        lastActivityAt: new Date("2026-08-19T08:00:00.000Z"),
      }),
    ] as any)
    // groupBy returns no row: there are no INBOUND messages to count.
    vi.mocked(prisma.message.groupBy).mockResolvedValue([] as any)
    const res = await listConversations({ tenantId: "t1", queue: "all", agentUserId: "u1" })
    expect(res.conversations[0].lastActivityAt).toBe("2026-08-19T08:00:00.000Z")
    expect(res.conversations[0].lastInboundAt).toBeNull()
    expect(res.conversations[0].unreadCount).toBe(0)
  })

  it("maps the mine queue to assigneeId = agent", async () => {
    vi.mocked(prisma.conversation.findMany).mockResolvedValue([] as any)
    vi.mocked(prisma.message.groupBy).mockResolvedValue([] as any)
    await listConversations({ tenantId: "t1", queue: "mine", agentUserId: "u9" })
    expect(prisma.conversation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tenantId: "t1", status: { not: "CLOSED" }, assigneeId: "u9" } }),
    )
  })

  it("scopes the closed queue to status = CLOSED, unfiltered by assignee", async () => {
    vi.mocked(prisma.conversation.findMany).mockResolvedValue([convRow({ status: "CLOSED" })] as any)
    vi.mocked(prisma.message.groupBy).mockResolvedValue([] as any)
    await listConversations({ tenantId: "t1", queue: "closed", agentUserId: "u1" })
    expect(prisma.conversation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tenantId: "t1", status: "CLOSED" } }),
    )
  })

  it("returns nextCursor when a full page is returned", async () => {
    const rows = Array.from({ length: 2 }, (_, i) => convRow({ id: `cv${i}` }))
    vi.mocked(prisma.conversation.findMany).mockResolvedValue(rows as any)
    vi.mocked(prisma.message.groupBy).mockResolvedValue([] as any)
    const res = await listConversations({ tenantId: "t1", queue: "all", agentUserId: "u1", limit: 2 })
    expect(res.nextCursor).toBe("cv1")
    expect(res.conversations.every((c) => c.unreadCount === 0)).toBe(true)
  })
})

describe("getThread", () => {
  it("returns null for a conversation outside the tenant", async () => {
    vi.mocked(prisma.conversation.findFirst).mockResolvedValue(null as any)
    const r = await getThread({ tenantId: "t1", conversationId: "cvX" })
    expect(r).toBeNull()
  })

  it("maps messages, media placeholder flag, window and linked entities", async () => {
    const now = new Date("2026-07-05T12:00:00.000Z")
    vi.mocked(prisma.conversation.findFirst).mockResolvedValue({
      id: "cv1", channel: "WHATSAPP", status: "OPEN", priority: "NORMAL", subject: null,
      assigneeId: "u2", assignee: { name: "Agent Sipho" },
      lastInboundAt: new Date("2026-07-05T11:30:00.000Z"), lastOutboundAt: null, createdAt: new Date("2026-07-05T09:00:00.000Z"),
      loanId: "L1", loan: { id: "L1", reference: "LN-001", status: "ACTIVE" },
      applicationId: null, application: null,
      contact: {
        id: "ct1", firstName: "Thabo", lastName: "M", primaryPhone: "27821234567",
        primaryWaJid: "27821234567@s.whatsapp.net", primaryEmail: null, status: "CLIENT",
        clientId: "cl1", leadId: null,
        lastInboundAtByChannel: { WHATSAPP: "2026-07-05T11:30:00.000Z" },
      },
      messages: [
        { id: "m1", direction: "INBOUND", isInternal: false, bodyText: "hi", status: "DELIVERED", provider: "WA_UNOFFICIAL", channel: "WHATSAPP", documentRefs: null, attachmentsMeta: null, errorMessage: null, createdById: null, createdBy: null, createdAt: new Date("2026-07-05T11:30:00.000Z"), sentAt: null, deliveredAt: new Date("2026-07-05T11:30:00.000Z"), readAt: null, mentions: [] },
        { id: "m2", direction: "OUTBOUND", isInternal: false, bodyText: "[img]", status: "SENT", provider: "WA_UNOFFICIAL", channel: "WHATSAPP", documentRefs: ["doc1"], attachmentsMeta: null, errorMessage: null, createdById: "u2", createdBy: { name: "Agent Sipho" }, createdAt: new Date("2026-07-05T11:31:00.000Z"), sentAt: new Date("2026-07-05T11:31:00.000Z"), deliveredAt: null, readAt: null, mentions: [{ userId: "u3", user: { name: "Bo Nkosi", email: "bo@x.co" } }] },
      ],
    } as any)
    vi.mocked(prisma.contactConsent.findFirst).mockResolvedValue(null as any)

    const r = await getThread({ tenantId: "t1", conversationId: "cv1", now })
    expect(r).not.toBeNull()
    expect(r!.conversation.assigneeName).toBe("Agent Sipho")
    expect(r!.contact.displayName).toBe("Thabo M")
    expect(r!.contact.waOptedOut).toBe(false)
    expect(r!.linked.loan).toEqual({ id: "L1", reference: "LN-001", status: "ACTIVE" })
    expect(r!.messages[1].hasMedia).toBe(true)
    expect(r!.messages[1].createdByName).toBe("Agent Sipho")
    // Flattened to { userId, name } at the DTO boundary — the Prisma
    // { user: { name } } shape must not reach a client component's props.
    expect(r!.messages[1].mentions).toEqual([{ userId: "u3", name: "Bo Nkosi", email: "bo@x.co" }])
    expect(r!.messages[0].mentions).toEqual([])
    // A dropped select is invisible to the mapper — every mention would just
    // render as plain text — so assert the query actually asks for them.
    expect(vi.mocked(prisma.conversation.findFirst).mock.calls[0][0]).toMatchObject({
      include: { messages: { include: { mentions: { select: { userId: true, user: { select: { name: true, email: true } } } } } } },
    })
    expect(r!.window.open).toBe(true) // 11:30 + 24h > 12:00
  })

  // Regression: getThread fell back to cv.lastInboundAt when
  // the contact JSON was empty, so the panel showed "24h reply window open"
  // while lib/whatsapp-cloud.ts — which reads ONLY the contact field — rejected
  // the reply with WA_OUTSIDE_WINDOW_NEEDS_TEMPLATE. The indicator must agree
  // with the sender, not with the conversation row.
  it("reports the window CLOSED when only the conversation carries recency (sender reads the contact)", async () => {
    const now = new Date("2026-07-05T12:00:00.000Z")
    vi.mocked(prisma.conversation.findFirst).mockResolvedValue({
      id: "cv1", channel: "WHATSAPP", status: "OPEN", priority: "NORMAL", subject: null,
      assigneeId: null, assignee: null,
      lastInboundAt: new Date("2026-07-05T11:30:00.000Z"), lastOutboundAt: null, createdAt: new Date("2026-07-05T09:00:00.000Z"),
      loanId: null, loan: null, applicationId: null, application: null,
      contact: {
        id: "ct1", firstName: "Thabo", lastName: "M", primaryPhone: "27821234567",
        primaryWaJid: null, primaryEmail: null, status: "CLIENT", clientId: "cl1", leadId: null,
        lastInboundAtByChannel: null,
      },
      messages: [],
    } as any)
    vi.mocked(prisma.contactConsent.findFirst).mockResolvedValue(null as any)

    const r = await getThread({ tenantId: "t1", conversationId: "cv1", now })
    expect(r!.window.open).toBe(false)
    expect(r!.window.expiresAt).toBeNull()
  })

  it("flags waOptedOut when a REVOKED SERVICE_COMMS consent row exists", async () => {
    vi.mocked(prisma.conversation.findFirst).mockResolvedValue({
      id: "cv1", channel: "WHATSAPP", status: "OPEN", priority: "NORMAL", subject: null,
      assigneeId: null, assignee: null, lastInboundAt: null, lastOutboundAt: null, createdAt: new Date(),
      loanId: null, loan: null, applicationId: null, application: null,
      contact: { id: "ct1", firstName: null, lastName: null, primaryPhone: "27829999999", primaryWaJid: null, primaryEmail: null, status: "UNKNOWN", clientId: null, leadId: null, lastInboundAtByChannel: null },
      messages: [],
    } as any)
    vi.mocked(prisma.contactConsent.findFirst).mockResolvedValue({ id: "cc1" } as any)
    const r = await getThread({ tenantId: "t1", conversationId: "cv1" })
    expect(r!.contact.waOptedOut).toBe(true)
    expect(r!.contact.displayName).toBe("27829999999")
    expect(r!.window.open).toBe(false)
  })
})

describe("getThread reply channels", () => {
  it("lists the channels contactReplyChannels reports", async () => {
    vi.mocked(contactReplyChannels).mockResolvedValue(["EMAIL"])
    vi.mocked(prisma.conversation.findFirst).mockResolvedValue({
      id: "cv1", channel: "WHATSAPP", status: "OPEN", priority: "NORMAL", subject: null,
      assigneeId: null, assignee: null, lastInboundAt: null, lastOutboundAt: null, createdAt: new Date(),
      loanId: null, loan: null, applicationId: null, application: null,
      contact: { id: "ct1", firstName: null, lastName: null, primaryPhone: "27829999999", primaryWaJid: null, primaryEmail: null, status: "UNKNOWN", clientId: null, leadId: null, lastInboundAtByChannel: null },
      messages: [],
    } as any)
    vi.mocked(prisma.contactConsent.findFirst).mockResolvedValue(null as any)

    const dto = await getThread({ tenantId: "t1", conversationId: "cv1" })

    expect(dto?.reply.availableChannels).toEqual(["EMAIL"])
  })

  it("defaults to the channel of the newest inbound message", async () => {
    vi.mocked(contactReplyChannels).mockResolvedValue(["EMAIL", "WHATSAPP"])
    vi.mocked(prisma.conversation.findFirst).mockResolvedValue({
      id: "cv1", channel: "WHATSAPP", status: "OPEN", priority: "NORMAL", subject: null,
      assigneeId: null, assignee: null, lastInboundAt: null, lastOutboundAt: null, createdAt: new Date(),
      loanId: null, loan: null, applicationId: null, application: null,
      contact: { id: "ct1", firstName: null, lastName: null, primaryPhone: "27829999999", primaryWaJid: null, primaryEmail: "t@x.co", status: "UNKNOWN", clientId: null, leadId: null, lastInboundAtByChannel: null },
      messages: [
        { id: "m1", direction: "INBOUND", isInternal: false, bodyText: "hi", status: "DELIVERED", provider: "WA_UNOFFICIAL", channel: "WHATSAPP", documentRefs: null, attachmentsMeta: null, errorMessage: null, createdById: null, createdBy: null, createdAt: new Date("2026-08-27T08:00:00.000Z"), sentAt: null, deliveredAt: null, readAt: null, mentions: [] },
        { id: "m2", direction: "INBOUND", isInternal: false, bodyText: "hi again", status: "DELIVERED", provider: "EMAIL", channel: "EMAIL", documentRefs: null, attachmentsMeta: null, errorMessage: null, createdById: null, createdBy: null, createdAt: new Date("2026-08-27T09:00:00.000Z"), sentAt: null, deliveredAt: null, readAt: null, mentions: [] },
      ],
    } as any)
    vi.mocked(prisma.contactConsent.findFirst).mockResolvedValue(null as any)

    const dto = await getThread({ tenantId: "t1", conversationId: "cv1" })

    expect(dto?.reply.defaultChannel).toBe("EMAIL")
  })

  it("falls back to Conversation.channel with no inbound messages", async () => {
    vi.mocked(contactReplyChannels).mockResolvedValue(["WHATSAPP"])
    vi.mocked(prisma.conversation.findFirst).mockResolvedValue({
      id: "cv1", channel: "WHATSAPP", status: "OPEN", priority: "NORMAL", subject: null,
      assigneeId: null, assignee: null, lastInboundAt: null, lastOutboundAt: null, createdAt: new Date(),
      loanId: null, loan: null, applicationId: null, application: null,
      contact: { id: "ct1", firstName: null, lastName: null, primaryPhone: "27829999999", primaryWaJid: null, primaryEmail: null, status: "UNKNOWN", clientId: null, leadId: null, lastInboundAtByChannel: null },
      messages: [
        { id: "m1", direction: "OUTBOUND", isInternal: false, bodyText: "hi", status: "SENT", provider: "WA_UNOFFICIAL", channel: "WHATSAPP", documentRefs: null, attachmentsMeta: null, errorMessage: null, createdById: "u1", createdBy: null, createdAt: new Date("2026-08-27T08:00:00.000Z"), sentAt: null, deliveredAt: null, readAt: null, mentions: [] },
      ],
    } as any)
    vi.mocked(prisma.contactConsent.findFirst).mockResolvedValue(null as any)

    const dto = await getThread({ tenantId: "t1", conversationId: "cv1" })

    expect(dto?.reply.defaultChannel).toBe("WHATSAPP")
  })

  it("keeps the WhatsApp window derived from lastInboundAtByChannel on a mixed thread", async () => {
    const waAt = new Date("2026-08-27T08:00:00.000Z")
    const now = new Date("2026-08-27T10:00:00.000Z")
    vi.mocked(contactReplyChannels).mockResolvedValue(["WHATSAPP", "EMAIL"])
    vi.mocked(prisma.conversation.findFirst).mockResolvedValue({
      id: "cv1", channel: "WHATSAPP", status: "OPEN", priority: "NORMAL", subject: null,
      assigneeId: null, assignee: null,
      lastInboundAt: new Date("2026-08-27T09:00:00.000Z"), lastOutboundAt: null, createdAt: new Date("2026-08-27T07:00:00.000Z"),
      loanId: null, loan: null, applicationId: null, application: null,
      contact: {
        id: "ct1", firstName: null, lastName: null, primaryPhone: "27829999999", primaryWaJid: null,
        primaryEmail: "t@x.co", status: "UNKNOWN", clientId: null, leadId: null,
        lastInboundAtByChannel: { WHATSAPP: waAt.toISOString() },
      },
      messages: [
        { id: "m1", direction: "INBOUND", isInternal: false, bodyText: "hi", status: "DELIVERED", provider: "WA_UNOFFICIAL", channel: "WHATSAPP", documentRefs: null, attachmentsMeta: null, errorMessage: null, createdById: null, createdBy: null, createdAt: waAt, sentAt: null, deliveredAt: null, readAt: null, mentions: [] },
        { id: "m2", direction: "INBOUND", isInternal: false, bodyText: "email later", status: "DELIVERED", provider: "EMAIL", channel: "EMAIL", documentRefs: null, attachmentsMeta: null, errorMessage: null, createdById: null, createdBy: null, createdAt: new Date("2026-08-27T09:00:00.000Z"), sentAt: null, deliveredAt: null, readAt: null, mentions: [] },
      ],
    } as any)
    vi.mocked(prisma.contactConsent.findFirst).mockResolvedValue(null as any)

    const dto = await getThread({ tenantId: "t1", conversationId: "cv1", now })

    expect(dto?.window.open).toBe(true)
    expect(dto?.window.expiresAt).toBe(new Date(waAt.getTime() + 24 * 60 * 60 * 1000).toISOString())
  })
})

it("toThreadMessage redacts the body of a deleted note", () => {
  const r = toThreadMessage({
    id: "n1", direction: "INTERNAL_NOTE", isInternal: true, bodyText: "regrettable",
    status: "QUEUED", provider: "MANUAL", channel: "EMAIL", errorMessage: null,
    errorClass: null, dispatchState: null, dispatchLeaseExpiresAt: null, templateId: null,
    createdById: "u1", createdBy: { name: "Ana" }, createdAt: new Date("2026-08-13T10:00:00Z"),
    sentAt: null, deliveredAt: null, readAt: null,
    editedAt: null, deletedAt: new Date("2026-08-13T11:00:00Z"), deletedBy: { name: "Ana" },
    mentions: [{ userId: "u2", user: { name: "Bo Nkosi", email: "bo@x.co" } }],
  } as any)
  expect(r.bodyText).toBeNull()
  expect(r.deletedByName).toBe("Ana")
  // Who was tagged stays true for a deleted note — only the body is redacted.
  // The bubble renders a tombstone with no body at all, so this cannot leak the
  // deleted text, and the bell items already sent must remain explicable.
  expect(r.mentions).toEqual([{ userId: "u2", name: "Bo Nkosi", email: "bo@x.co" }])
})

it("toThreadMessage keeps a mention whose user row has no name", () => {
  const r = toThreadMessage({
    id: "n2", direction: "INTERNAL_NOTE", isInternal: true, bodyText: "@dee@x.co look",
    status: "QUEUED", provider: "MANUAL", channel: "EMAIL", errorMessage: null,
    errorClass: null, dispatchState: null, dispatchLeaseExpiresAt: null, templateId: null,
    createdById: "u1", createdBy: { name: "Ana" }, createdAt: new Date("2026-08-13T10:00:00Z"),
    sentAt: null, deliveredAt: null, readAt: null,
    editedAt: null, deletedAt: null, deletedBy: null,
    mentions: [{ userId: "u4", user: { name: null, email: "dee@x.co" } }],
  } as any)
  // The email travels with the row: the picker inserted "@dee@x.co" for this
  // staffer, so it is the only label the bubble can highlight.
  expect(r.mentions).toEqual([{ userId: "u4", name: null, email: "dee@x.co" }])
})

describe("resolveQueueForConversation", () => {
  it("returns null when the conversation isn't found in this tenant", async () => {
    vi.mocked(prisma.conversation.findFirst).mockResolvedValue(null as any)
    const r = await resolveQueueForConversation({ tenantId: "t1", conversationId: "cvX", agentUserId: "u1" })
    expect(r).toBeNull()
  })

  it("maps status = CLOSED to the closed queue regardless of assignee", async () => {
    vi.mocked(prisma.conversation.findFirst).mockResolvedValue({ status: "CLOSED", assigneeId: "u9" } as any)
    const r = await resolveQueueForConversation({ tenantId: "t1", conversationId: "cv1", agentUserId: "u1" })
    expect(r).toBe("closed")
  })

  it("maps a null assignee to unassigned", async () => {
    vi.mocked(prisma.conversation.findFirst).mockResolvedValue({ status: "OPEN", assigneeId: null } as any)
    const r = await resolveQueueForConversation({ tenantId: "t1", conversationId: "cv1", agentUserId: "u1" })
    expect(r).toBe("unassigned")
  })

  it("maps the calling agent's own assignment to mine", async () => {
    vi.mocked(prisma.conversation.findFirst).mockResolvedValue({ status: "OPEN", assigneeId: "u1" } as any)
    const r = await resolveQueueForConversation({ tenantId: "t1", conversationId: "cv1", agentUserId: "u1" })
    expect(r).toBe("mine")
  })

  it("maps another agent's assignment to all", async () => {
    vi.mocked(prisma.conversation.findFirst).mockResolvedValue({ status: "OPEN", assigneeId: "u9" } as any)
    const r = await resolveQueueForConversation({ tenantId: "t1", conversationId: "cv1", agentUserId: "u1" })
    expect(r).toBe("all")
  })
})

// Conversation.channel is only the channel a thread was OPENED on; one thread
// carries every channel. The queue badge must follow the newest
// customer-facing message, or a WhatsApp reminder in an email-opened thread
// is badged EMAIL.
describe("queue channel badge", () => {
  it("badges a conversation with its newest customer-facing message's channel", async () => {
    vi.mocked(prisma.conversation.findMany).mockResolvedValue([convRow({ id: "cv1", channel: "EMAIL" })] as any)
    vi.mocked(prisma.message.groupBy).mockResolvedValue([] as any)
    vi.mocked(prisma.$queryRaw).mockResolvedValue([{ conversationId: "cv1", channel: "WHATSAPP" }] as never)

    const res = await listConversations({ tenantId: "t1", queue: "all", agentUserId: "u1" })

    expect(res.conversations[0].channel).toBe("WHATSAPP")
  })

  it("falls back to Conversation.channel when the thread has no customer-facing message", async () => {
    vi.mocked(prisma.conversation.findMany).mockResolvedValue([convRow({ id: "cv1", channel: "EMAIL" })] as any)
    vi.mocked(prisma.message.groupBy).mockResolvedValue([] as any)

    const res = await listConversations({ tenantId: "t1", queue: "all", agentUserId: "u1" })

    expect(res.conversations[0].channel).toBe("EMAIL")
  })

  it("looks the channel up tenant-scoped, for exactly the listed conversations, excluding internal notes and never-sent rows", async () => {
    vi.mocked(prisma.conversation.findMany).mockResolvedValue([convRow({ id: "cv1" }), convRow({ id: "cv2" })] as any)
    vi.mocked(prisma.message.groupBy).mockResolvedValue([] as any)

    await listConversations({ tenantId: "t1", queue: "all", agentUserId: "u1" })

    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1)
    const [strings, ...values] = vi.mocked(prisma.$queryRaw).mock.calls[0] as unknown as [TemplateStringsArray, ...unknown[]]
    const sql = strings.join("?")
    expect(sql).toContain(`"isInternal" = false`)
    expect(sql).toContain(`"direction" <> 'INTERNAL_NOTE'`)
    expect(sql).toContain(`"status" <> 'SIMULATED'`)
    expect(values[0]).toBe("t1")
    expect((values[1] as { values: unknown[] }).values).toEqual(["cv1", "cv2"])
  })

  it("skips the lookup on an empty page", async () => {
    vi.mocked(prisma.conversation.findMany).mockResolvedValue([] as any)

    await listConversations({ tenantId: "t1", queue: "all", agentUserId: "u1" })

    expect(prisma.$queryRaw).not.toHaveBeenCalled()
  })

  it("gives a pinned deep-linked conversation the same badge", async () => {
    vi.mocked(prisma.conversation.findFirst).mockResolvedValue(convRow({ id: "cv9", channel: "EMAIL" }) as any)
    vi.mocked(prisma.message.count).mockResolvedValue(0 as any)
    vi.mocked(prisma.$queryRaw).mockResolvedValue([{ conversationId: "cv9", channel: "WHATSAPP" }] as never)

    const r = await getConversationSummary({ tenantId: "t1", conversationId: "cv9" })

    expect(r!.channel).toBe("WHATSAPP")
  })
})

describe("getConversationSummary", () => {
  it("returns null for a conversation outside the tenant (deep link pin ignored)", async () => {
    vi.mocked(prisma.conversation.findFirst).mockResolvedValue(null as any)
    const r = await getConversationSummary({ tenantId: "t1", conversationId: "cvX" })
    expect(r).toBeNull()
    expect(prisma.message.count).not.toHaveBeenCalled()
  })

  it("maps a found conversation to the same summary shape listConversations produces, scoped to the same tenant", async () => {
    vi.mocked(prisma.conversation.findFirst).mockResolvedValue(convRow({ id: "cv9", status: "CLOSED" }) as any)
    vi.mocked(prisma.message.count).mockResolvedValue(2 as any)

    const r = await getConversationSummary({ tenantId: "t1", conversationId: "cv9" })

    expect(prisma.conversation.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "cv9", tenantId: "t1" } }),
    )
    expect(prisma.message.count).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tenantId: "t1", conversationId: "cv9", direction: "INBOUND", readAt: null } }),
    )
    expect(r).not.toBeNull()
    expect(r!.id).toBe("cv9")
    expect(r!.contactName).toBe("Thabo M")
    expect(r!.unreadCount).toBe(2)
  })
})

describe("matchesQueue", () => {
  describe("closed queue — status-only, assignee-agnostic", () => {
    it("matches any assignee when status is CLOSED", () => {
      expect(matchesQueue("closed", { status: "CLOSED", assigneeId: "u1" }, "u1")).toBe(true)
      expect(matchesQueue("closed", { status: "CLOSED", assigneeId: "u9" }, "u1")).toBe(true)
      expect(matchesQueue("closed", { status: "CLOSED", assigneeId: null }, "u1")).toBe(true)
    })
    it("doesn't match a non-CLOSED status regardless of assignee", () => {
      expect(matchesQueue("closed", { status: "OPEN", assigneeId: "u1" }, "u1")).toBe(false)
      expect(matchesQueue("closed", { status: "PENDING_CUSTOMER", assigneeId: null }, "u1")).toBe(false)
    })
  })

  describe("unassigned queue", () => {
    it("matches a non-CLOSED conversation with no assignee", () => {
      expect(matchesQueue("unassigned", { status: "OPEN", assigneeId: null }, "u1")).toBe(true)
    })
    it("doesn't match once assigned", () => {
      expect(matchesQueue("unassigned", { status: "OPEN", assigneeId: "u1" }, "u1")).toBe(false)
    })
    it("doesn't match when CLOSED, even with no assignee", () => {
      expect(matchesQueue("unassigned", { status: "CLOSED", assigneeId: null }, "u1")).toBe(false)
    })
  })

  describe("mine queue", () => {
    it("matches a non-CLOSED conversation assigned to the calling agent", () => {
      expect(matchesQueue("mine", { status: "OPEN", assigneeId: "u1" }, "u1")).toBe(true)
    })
    it("doesn't match another agent's assignment", () => {
      expect(matchesQueue("mine", { status: "OPEN", assigneeId: "u9" }, "u1")).toBe(false)
    })
    it("doesn't match when unassigned", () => {
      expect(matchesQueue("mine", { status: "OPEN", assigneeId: null }, "u1")).toBe(false)
    })
    it("doesn't match when CLOSED, even if assigned to the calling agent", () => {
      expect(matchesQueue("mine", { status: "CLOSED", assigneeId: "u1" }, "u1")).toBe(false)
    })
  })

  describe("all queue — non-CLOSED, assignee-agnostic", () => {
    it("matches any non-CLOSED conversation regardless of assignee", () => {
      expect(matchesQueue("all", { status: "OPEN", assigneeId: "u1" }, "u1")).toBe(true)
      expect(matchesQueue("all", { status: "PENDING_INTERNAL", assigneeId: "u9" }, "u1")).toBe(true)
      expect(matchesQueue("all", { status: "OPEN", assigneeId: null }, "u1")).toBe(true)
    })
    it("doesn't match when CLOSED", () => {
      expect(matchesQueue("all", { status: "CLOSED", assigneeId: "u1" }, "u1")).toBe(false)
    })
  })

  // InboxClient's pinned-row guard clears the pin only when matchesQueue's
  // result *differs* before vs. after a status/assignee change. These pin
  // scenarios exercise that comparison directly.
  describe("pin-guard scenarios (InboxClient)", () => {
    it("does NOT flip for a status-only triage that keeps membership (mine queue, OPEN -> PENDING_CUSTOMER)", () => {
      const before = matchesQueue("mine", { status: "OPEN", assigneeId: "u1" }, "u1")
      const after = matchesQueue("mine", { status: "PENDING_CUSTOMER", assigneeId: "u1" }, "u1")
      expect(before).toBe(true)
      expect(after).toBe(true) // same -> pin must NOT be cleared
    })
    it("does NOT flip for a reassignment while still CLOSED (closed queue is assignee-agnostic)", () => {
      const before = matchesQueue("closed", { status: "CLOSED", assigneeId: "u1" }, "u1")
      const after = matchesQueue("closed", { status: "CLOSED", assigneeId: "u2" }, "u1")
      expect(before).toBe(true)
      expect(after).toBe(true) // same -> pin must NOT be cleared
    })
    it("DOES flip when a Closed conversation is reopened (closed queue)", () => {
      const before = matchesQueue("closed", { status: "CLOSED", assigneeId: "u1" }, "u1")
      const after = matchesQueue("closed", { status: "OPEN", assigneeId: "u1" }, "u1")
      expect(before).toBe(true)
      expect(after).toBe(false) // differs -> pin must be cleared
    })
  })
})
