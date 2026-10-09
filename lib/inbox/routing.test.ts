/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest"
import { routeInbound } from "./routing"

function makeTx() {
  return {
    contact: { create: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
    conversation: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
    message: { create: vi.fn() },
  }
}

const baseCtx = {
  tenantId: "t1",
  fromValue: "27821234567@s.whatsapp.net",
  fromPhone: "0821234567",
  text: "hi",
  providerMessageId: "wamid-1",
  waEnabled: true,
  isStop: false,
  provider: "WA_UNOFFICIAL" as const,
  now: new Date("2026-07-05T12:00:00.000Z"),
}

beforeEach(() => vi.clearAllMocks())

it("does nothing when the WhatsApp channel is disabled", async () => {
  const tx = makeTx()
  const r = await routeInbound(tx as any, { ...baseCtx, waEnabled: false })
  expect(r).toEqual({ handled: false, persisted: false })
  expect(tx.contact.create).not.toHaveBeenCalled()
})

it("drops an implausible number", async () => {
  const tx = makeTx()
  const r = await routeInbound(tx as any, { ...baseCtx, fromPhone: "123" })
  expect(r).toEqual({ handled: false, persisted: false })
  expect(tx.contact.create).not.toHaveBeenCalled()
})

it("does not provision an unknown sender whose message is STOP", async () => {
  const tx = makeTx()
  const r = await routeInbound(tx as any, { ...baseCtx, isStop: true })
  expect(r).toEqual({ handled: false, persisted: false })
  expect(tx.contact.create).not.toHaveBeenCalled()
})

it("provisions contact + conversation + message for a plausible unknown sender", async () => {
  const tx = makeTx()
  tx.contact.create.mockResolvedValue({ id: "ct1" })
  tx.conversation.findFirst.mockResolvedValue(null)
  tx.conversation.create.mockResolvedValue({ id: "cv1" })
  tx.message.create.mockResolvedValue({ id: "m1" })
  tx.contact.findUnique.mockResolvedValue({ lastInboundAtByChannel: null })

  const r = await routeInbound(tx as any, baseCtx)

  expect(r).toEqual({ handled: true, persisted: true, conversationId: "cv1", messageId: "m1", contactId: "ct1" })
  expect(tx.contact.create).toHaveBeenCalledWith(
    expect.objectContaining({
      data: expect.objectContaining({
        tenantId: "t1",
        status: "UNKNOWN",
        firstSeenChannel: "WHATSAPP",
        primaryWaJid: "27821234567@s.whatsapp.net",
        primaryPhone: "27821234567",
        identities: {
          create: expect.objectContaining({
            channel: "WHATSAPP",
            value: "27821234567@s.whatsapp.net",
            verified: true,
            source: "INBOUND",
          }),
        },
      }),
    }),
  )
  expect(tx.message.create).toHaveBeenCalledWith(
    expect.objectContaining({
      data: expect.objectContaining({
        direction: "INBOUND",
        provider: "WA_UNOFFICIAL",
        bodyText: "hi",
        conversationId: "cv1",
        channel: "WHATSAPP",
        status: "DELIVERED",
        providerMessageId: "wamid-1",
        fromValue: "27821234567@s.whatsapp.net",
      }),
    }),
  )
  // lastActivityAt rides along on every lastInboundAt write — it is the inbox
  // queue's sort key, and a writer that skips it silently stops the thread
  // sorting by its newest traffic.
  expect(tx.conversation.update).toHaveBeenCalledWith({
    where: { id: "cv1", tenantId: "t1" },
    data: { lastInboundAt: baseCtx.now, lastActivityAt: baseCtx.now },
  })
  expect(tx.contact.update).toHaveBeenCalledWith(
    expect.objectContaining({ data: { lastInboundAtByChannel: { WHATSAPP: baseCtx.now.toISOString() } } }),
  )
})

// Regression: same NULLS FIRST trap as lib/inbox/conversations.ts, but worse
// here — this orderBy picks which existing open WhatsApp thread an incoming
// message joins. Without nulls-last, a contact with one outbound-only thread
// (lastInboundAt = NULL) plus a genuinely active one could have a reply
// attached to the stale NULL thread instead of the live one. Mocked Prisma
// can't execute real SQL ordering, so this asserts the query shape sent to
// findFirst.
it("orders the existing-thread lookup by lastInboundAt NULLS LAST", async () => {
  const tx = makeTx()
  tx.contact.create.mockResolvedValue({ id: "ct1" })
  tx.conversation.findFirst.mockResolvedValue(null)
  tx.conversation.create.mockResolvedValue({ id: "cv1" })
  tx.message.create.mockResolvedValue({ id: "m1" })
  tx.contact.findUnique.mockResolvedValue({ lastInboundAtByChannel: null })

  await routeInbound(tx as any, baseCtx)

  expect(tx.conversation.findFirst).toHaveBeenCalledWith(
    expect.objectContaining({
      orderBy: [{ lastInboundAt: { sort: "desc", nulls: "last" } }, { id: "desc" }],
    }),
  )
})

it("reuses the open conversation when one exists", async () => {
  const tx = makeTx()
  tx.contact.create.mockResolvedValue({ id: "ct1" })
  tx.conversation.findFirst.mockResolvedValue({ id: "cvExisting" })
  tx.message.create.mockResolvedValue({ id: "m2" })
  tx.contact.findUnique.mockResolvedValue({ lastInboundAtByChannel: { EMAIL: "x" } })

  const r = await routeInbound(tx as any, baseCtx)

  expect(r.conversationId).toBe("cvExisting")
  expect(tx.conversation.create).not.toHaveBeenCalled()
  // merge preserves other channels
  expect(tx.contact.update).toHaveBeenCalledWith(
    expect.objectContaining({ data: { lastInboundAtByChannel: { EMAIL: "x", WHATSAPP: baseCtx.now.toISOString() } } }),
  )
})

// Regression: the Cloud webhook defines PROVIDER = "WA_CLOUD" and threads it
// into the inbound path, but this one hardcoded WA_UNOFFICIAL. Every Cloud
// inbound row was therefore stored as bridge traffic and disagreed with its own
// AuditLog, which logs the constant directly — same messageId, same second,
// two different providers.
it("stores the provider the caller passed, not a hardcoded WA_UNOFFICIAL", async () => {
  const tx = makeTx()
  tx.contact.create.mockResolvedValue({ id: "ct1" } as any)
  tx.contact.findUnique.mockResolvedValue({ lastInboundAtByChannel: null } as any)
  tx.conversation.findFirst.mockResolvedValue({ id: "cv1" } as any)
  tx.message.create.mockResolvedValue({ id: "m1" } as any)

  await routeInbound(tx as any, { ...baseCtx, provider: "WA_CLOUD" })

  expect(tx.message.create).toHaveBeenCalledWith(
    expect.objectContaining({ data: expect.objectContaining({ provider: "WA_CLOUD" }) }),
  )
})

it("stores WA_UNOFFICIAL when the bridge webhook passes it", async () => {
  const tx = makeTx()
  tx.contact.create.mockResolvedValue({ id: "ct1" } as any)
  tx.contact.findUnique.mockResolvedValue({ lastInboundAtByChannel: null } as any)
  tx.conversation.findFirst.mockResolvedValue({ id: "cv1" } as any)
  tx.message.create.mockResolvedValue({ id: "m1" } as any)

  await routeInbound(tx as any, { ...baseCtx, provider: "WA_UNOFFICIAL" })

  expect(tx.message.create).toHaveBeenCalledWith(
    expect.objectContaining({ data: expect.objectContaining({ provider: "WA_UNOFFICIAL" }) }),
  )
})

it("looks up the open thread without a channel predicate", async () => {
  const tx = makeTx()
  tx.contact.create.mockResolvedValue({ id: "ct1" })
  tx.conversation.findFirst.mockResolvedValue(null)
  tx.conversation.create.mockResolvedValue({ id: "cv1" })
  tx.message.create.mockResolvedValue({ id: "m1" })
  tx.contact.findUnique.mockResolvedValue({ lastInboundAtByChannel: null })

  await routeInbound(tx as any, baseCtx)

  const where = tx.conversation.findFirst.mock.calls[0][0].where
  expect(where).toEqual({ tenantId: "t1", contactId: "ct1", closedAt: null })
  expect(Object.keys(where)).not.toContain("channel")
})

it("reuses the contact's open thread whatever channel it was opened on", async () => {
  const tx = makeTx()
  tx.contact.create.mockResolvedValue({ id: "ct1" })
  tx.conversation.findFirst.mockResolvedValue({ id: "cv-email" })
  tx.message.create.mockResolvedValue({ id: "m1" })
  tx.contact.findUnique.mockResolvedValue({ lastInboundAtByChannel: null })

  const r = await routeInbound(tx as any, baseCtx)

  expect(r.conversationId).toBe("cv-email")
  expect(tx.conversation.create).not.toHaveBeenCalled()
  expect(tx.message.create.mock.calls[0][0].data.channel).toBe("WHATSAPP")
})
