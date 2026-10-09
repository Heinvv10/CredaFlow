/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@/lib/prisma", () => ({
  prisma: {
    contact: { findFirst: vi.fn() },
    conversation: { findMany: vi.fn() },
  },
}))
vi.mock("@/lib/messaging/channel-availability", () => ({ getChannelAvailability: vi.fn() }))
vi.mock("@/lib/inbox/settings", () => ({ getCommsSettings: vi.fn() }))
vi.mock("./reply-channels", () => ({ contactReplyChannels: vi.fn() }))

import { getContactComms } from "./contact-comms"
import { prisma } from "@/lib/prisma"
import { getChannelAvailability } from "@/lib/messaging/channel-availability"
import { getCommsSettings } from "@/lib/inbox/settings"
import { contactReplyChannels } from "./reply-channels"

const now = new Date("2026-07-08T12:00:00.000Z")

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getCommsSettings).mockResolvedValue({ whatsappEnabled: true } as any)
  vi.mocked(contactReplyChannels).mockResolvedValue([])
  vi.mocked(getChannelAvailability).mockResolvedValue({
    EMAIL: { enabled: true, toValue: "c@x.co" },
    WHATSAPP: { enabled: false, reason: "WhatsApp channel is off" },
    SMS: { enabled: false, reason: "No SMS on file" },
  } as any)
  vi.mocked(prisma.contact.findFirst).mockResolvedValue({
    id: "ct1", primaryPhone: "27820000000", primaryWaJid: null, primaryEmail: "c@x.co",
    blockedAt: null, status: "ACTIVE", lastInboundAtByChannel: null,
  } as any)
})

function convRow(over: Record<string, unknown> = {}) {
  return {
    id: "cv1", channel: "EMAIL", status: "OPEN", subject: "Statement", updatedAt: now,
    lastInboundAt: now, lastOutboundAt: null, createdAt: now,
    loan: null, application: null,
    messages: [
      {
        id: "m1", direction: "INBOUND", isInternal: false, bodyText: "Hi", status: "DELIVERED",
        provider: "SMTP", channel: "EMAIL", documentRefs: null, attachmentsMeta: null, errorMessage: null,
        createdById: null, createdBy: null, createdAt: new Date("2026-07-08T09:00:00.000Z"),
        sentAt: null, deliveredAt: now, readAt: null, mentions: [],
      },
    ],
    ...over,
  }
}

describe("getContactComms", () => {
  it("scopes conversations to the tenant + contact", async () => {
    vi.mocked(prisma.conversation.findMany).mockResolvedValue([convRow()] as any)
    await getContactComms({ tenantId: "t1", contactId: "ct1", now })
    const arg = vi.mocked(prisma.conversation.findMany).mock.calls[0][0] as any
    expect(arg.where).toEqual({ tenantId: "t1", contactId: "ct1" })
  })

  // The client record's Comms tab is where staff go to check what we sent. A
  // thread we only ever SENT on has lastInboundAt = null, so ordering by that
  // key sank it to the bottom of the client's own history — the one thread
  // they came to find, ranked last. lastActivityAt is the later of
  // lastInboundAt and lastOutboundAt, so it ranks by real recency either way.
  //
  // Query shape only: a mocked Prisma cannot execute an ORDER BY. The row
  // order itself is proved in conversation-last-activity.integration.test.ts.
  it("orders the contact's threads by lastActivityAt, not lastInboundAt", async () => {
    vi.mocked(prisma.conversation.findMany).mockResolvedValue([convRow()] as any)
    await getContactComms({ tenantId: "t1", contactId: "ct1", now })
    const arg = vi.mocked(prisma.conversation.findMany).mock.calls[0][0] as any
    expect(arg.orderBy).toEqual([{ lastActivityAt: { sort: "desc", nulls: "last" } }, { id: "desc" }])
    expect(JSON.stringify(arg.orderBy)).not.toContain("lastInboundAt")
  })

  // The client Comms tab is the surface staff actually use for notes. A dropped
  // mentions select is invisible to the mapper and to every render test — the
  // bubble just shows every mention as plain text — so assert the query shape.
  it("selects the mention rows needed to highlight a note", async () => {
    vi.mocked(prisma.conversation.findMany).mockResolvedValue([] as any)
    await getContactComms({ tenantId: "t1", contactId: "ct1", now })
    const arg = vi.mocked(prisma.conversation.findMany).mock.calls[0][0] as any
    expect(arg.include.messages.include.mentions).toEqual({
      select: { userId: true, user: { select: { name: true, email: true } } },
    })
  })

  it("flattens messages across conversations, sorted createdAt asc, tagged with conversationId", async () => {
    vi.mocked(prisma.conversation.findMany).mockResolvedValue([
      convRow({
        id: "cvA", messages: [{
          id: "mA", direction: "OUTBOUND", isInternal: false, bodyText: "later", status: "SENT",
          provider: "SMTP", channel: "EMAIL", documentRefs: null, attachmentsMeta: null, errorMessage: null,
          createdById: "u1", createdBy: { name: "Agent" }, createdAt: new Date("2026-07-08T11:00:00.000Z"),
          sentAt: now, deliveredAt: null, readAt: null, mentions: [],
        }],
      }),
      convRow({
        id: "cvB", messages: [{
          id: "mB", direction: "INBOUND", isInternal: false, bodyText: "earlier", status: "DELIVERED",
          provider: "WHATSAPP", channel: "WHATSAPP", documentRefs: null, attachmentsMeta: null, errorMessage: null,
          createdById: null, createdBy: null, createdAt: new Date("2026-07-08T08:00:00.000Z"),
          sentAt: null, deliveredAt: now, readAt: null, mentions: [],
        }],
      }),
    ] as any)

    const r = await getContactComms({ tenantId: "t1", contactId: "ct1", now })
    expect(r.messages.map((m) => m.id)).toEqual(["mB", "mA"])
    expect(r.messages.map((m) => m.conversationId)).toEqual(["cvB", "cvA"])
    expect(r.conversations.map((c) => c.id)).toContain("cvA")
    expect(r.conversations.find((c) => c.id === "cvA")?.messageCount).toBe(1)
  })

  it("returns channelAvailability and an empty result set for a contact with no conversations", async () => {
    vi.mocked(prisma.conversation.findMany).mockResolvedValue([] as any)
    const r = await getContactComms({ tenantId: "t1", contactId: "ct1", now })
    expect(r.messages).toEqual([])
    expect(r.conversations).toEqual([])
    expect(r.channelAvailability.EMAIL.enabled).toBe(true)
    expect(r.waWindow).toEqual({ open: false, expiresAt: null })
  })

  it("takes replyChannels from contactReplyChannels, the one source of truth", async () => {
    // The old test here was named for identities but actually asserted on
    // channelAvailability toValue — two different rules. Both this surface and
    // the send gate now read lib/inbox/reply-channels.ts, so the decision is
    // tested once, there; what this asserts is that the tab passes it through.
    vi.mocked(contactReplyChannels).mockResolvedValue(["WHATSAPP", "EMAIL"])
    vi.mocked(prisma.conversation.findMany).mockResolvedValue([] as any)
    const r = await getContactComms({ tenantId: "t1", contactId: "ct1", now })
    expect(r.replyChannels).toEqual(["WHATSAPP", "EMAIL"])
    expect(contactReplyChannels).toHaveBeenCalledWith("t1", "ct1")
  })

  it("computes the WhatsApp window from lastInboundAtByChannel.WHATSAPP", async () => {
    vi.mocked(prisma.contact.findFirst).mockResolvedValue({
      id: "ct1", primaryPhone: "27820000000", primaryWaJid: "27820000000@s.whatsapp.net", primaryEmail: null,
      blockedAt: null, status: "ACTIVE",
      lastInboundAtByChannel: { WHATSAPP: "2026-07-08T11:30:00.000Z" },
    } as any)
    vi.mocked(prisma.conversation.findMany).mockResolvedValue([] as any)
    const r = await getContactComms({ tenantId: "t1", contactId: "ct1", now })
    expect(r.waWindow.open).toBe(true)
  })

  it("falls back to all-disabled availability when the contact row is missing, but still returns conversations", async () => {
    vi.mocked(prisma.contact.findFirst).mockResolvedValue(null as any)
    vi.mocked(prisma.conversation.findMany).mockResolvedValue([convRow()] as any)

    const r = await getContactComms({ tenantId: "t1", contactId: "ct1", now })

    expect(getChannelAvailability).not.toHaveBeenCalled()
    expect(r.channelAvailability.EMAIL.enabled).toBe(false)
    expect(r.channelAvailability.WHATSAPP.enabled).toBe(false)
    expect(r.channelAvailability.SMS.enabled).toBe(false)
    expect(r.channelAvailability.EMAIL.reason).toBe("No contact")
    expect(r.waWindow).toEqual({ open: false, expiresAt: null })
    expect(r.conversations.map((c) => c.id)).toEqual(["cv1"])
    expect(r.messages.map((m) => m.id)).toEqual(["m1"])
    expect(r.messages.map((m) => m.conversationId)).toEqual(["cv1"])
  })
})
