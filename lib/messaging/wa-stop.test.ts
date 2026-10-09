import { describe, it, expect, vi } from "vitest"
import { handleWaStopInbound, STOP_REGEX } from "./wa-stop"

describe("STOP_REGEX", () => {
  it("matches case-insensitive STOP at the start", () => {
    expect(STOP_REGEX.test("STOP")).toBe(true)
    expect(STOP_REGEX.test("stop")).toBe(true)
    expect(STOP_REGEX.test("Stop please")).toBe(true)
  })
  it("rejects STOP not at the start", () => {
    expect(STOP_REGEX.test("please STOP")).toBe(false)
  })
  it("rejects STOPped (word-boundary)", () => {
    expect(STOP_REGEX.test("STOPped")).toBe(false)
    expect(STOP_REGEX.test("STOPPING")).toBe(false)
  })
})

describe("handleWaStopInbound", () => {
  type TxMock = {
    $queryRawUnsafe: ReturnType<typeof vi.fn>
    contactConsent: {
      updateMany: ReturnType<typeof vi.fn>
      create: ReturnType<typeof vi.fn>
    }
    conversation: {
      findFirst: ReturnType<typeof vi.fn>
      create: ReturnType<typeof vi.fn>
      update: ReturnType<typeof vi.fn>
    }
    message: {
      create: ReturnType<typeof vi.fn>
    }
    contact: {
      findUnique: ReturnType<typeof vi.fn>
      update: ReturnType<typeof vi.fn>
    }
  }
  function fakeTx(): TxMock {
    return {
      $queryRawUnsafe: vi.fn(async () => [{ id: "ct_a" }]),
      contactConsent: {
        updateMany: vi.fn(async () => ({ count: 1 })),
        create: vi.fn(async () => ({ id: "csn_new", status: "REVOKED" })),
      },
      conversation: {
        findFirst: vi.fn(async () => null),
        create: vi.fn(async () => ({ id: "cnv_new" })),
        update: vi.fn(async () => ({ id: "cnv_existing" })),
      },
      message: {
        create: vi.fn(async () => ({ id: "msg_new" })),
      },
      contact: {
        findUnique: vi.fn(async () => ({ lastInboundAtByChannel: null })),
        update: vi.fn(async () => ({ id: "ct_a" })),
      },
    }
  }

  const baseOpts = {
    tenantId: "tenant_a",
    contact: { id: "ct_a", tenantId: "tenant_a" },
    fromValue: "27821234567@s.whatsapp.net",
    text: "STOP",
    providerMessageId: "wamid.HBgL_test",
    provider: "WA_UNOFFICIAL" as const,
    now: new Date("2026-05-22T10:00:00Z"),
  }

  it("STOP keyword writes REVOKED consent row + closes prior + Message + Conversation create", async () => {
    const tx = fakeTx()
    const result = await handleWaStopInbound(tx as unknown as Parameters<typeof handleWaStopInbound>[0], baseOpts)

    expect(tx.$queryRawUnsafe).toHaveBeenCalledWith(
      expect.stringMatching(/FROM "Contact"[\s\S]*FOR UPDATE/),
      "ct_a",
      "tenant_a",
    )
    expect(tx.$queryRawUnsafe.mock.invocationCallOrder[0]).toBeLessThan(
      tx.contactConsent.create.mock.invocationCallOrder[0],
    )

    expect(tx.contactConsent.updateMany).toHaveBeenCalledWith({
      where: {
        contactId: "ct_a",
        channel: "WHATSAPP",
        purpose: "SERVICE_COMMS",
        effectiveTo: null,
      },
      data: { effectiveTo: baseOpts.now },
    })
    expect(tx.contactConsent.create).toHaveBeenCalledWith({
      data: {
        tenantId: "tenant_a",
        contactId: "ct_a",
        channel: "WHATSAPP",
        purpose: "SERVICE_COMMS",
        status: "REVOKED",
        source: "WA_REPLY_KEYWORD",
        effectiveFrom: baseOpts.now,
      },
    })
    expect(tx.message.create).toHaveBeenCalledTimes(1)
    expect(tx.message.create.mock.calls[0][0].data).toMatchObject({
      tenantId: "tenant_a",
      conversationId: "cnv_new",
      channel: "WHATSAPP",
      direction: "INBOUND",
      provider: "WA_UNOFFICIAL",
      providerMessageId: "wamid.HBgL_test",
      fromValue: "27821234567@s.whatsapp.net",
      bodyText: "STOP",
    })
    expect(result).toEqual({
      messageId: "msg_new",
      consentRevokedId: "csn_new",
      conversationId: "cnv_new",
    })
  })

  it("non-STOP body writes Message only (no consent rows)", async () => {
    const tx = fakeTx()
    const result = await handleWaStopInbound(tx as unknown as Parameters<typeof handleWaStopInbound>[0], {
      ...baseOpts,
      text: "Hello, what is my balance?",
    })
    expect(tx.contactConsent.updateMany).not.toHaveBeenCalled()
    expect(tx.contactConsent.create).not.toHaveBeenCalled()
    expect(tx.$queryRawUnsafe).not.toHaveBeenCalled()
    expect(tx.message.create).toHaveBeenCalledTimes(1)
    expect(result).toEqual({
      messageId: "msg_new",
      consentRevokedId: null,
      conversationId: "cnv_new",
    })
  })

  // Regression (prod, 2026-08-11): this path updated Conversation.lastInboundAt
  // but never Contact.lastInboundAtByChannel, which is the ONLY field the
  // WhatsApp Cloud sender reads for Meta's 24h service window. Every known
  // contact therefore read a null window and free-text replies failed closed
  // with WA_OUTSIDE_WINDOW_NEEDS_TEMPLATE minutes after the customer wrote.
  it("refreshes Contact.lastInboundAtByChannel.WHATSAPP so the 24h send window opens", async () => {
    const tx = fakeTx()
    await handleWaStopInbound(tx as unknown as Parameters<typeof handleWaStopInbound>[0], {
      ...baseOpts,
      text: "Did you get my message?",
    })
    expect(tx.contact.update).toHaveBeenCalledWith({
      where: { id: "ct_a" },
      data: { lastInboundAtByChannel: { WHATSAPP: baseOpts.now.toISOString() } },
    })
  })

  it("merges the WhatsApp stamp without dropping another channel's", async () => {
    const tx = fakeTx()
    tx.contact.findUnique.mockResolvedValue({
      lastInboundAtByChannel: { EMAIL: "2026-01-01T00:00:00.000Z" },
    })
    await handleWaStopInbound(tx as unknown as Parameters<typeof handleWaStopInbound>[0], baseOpts)
    expect(tx.contact.update.mock.calls[0][0].data.lastInboundAtByChannel).toEqual({
      EMAIL: "2026-01-01T00:00:00.000Z",
      WHATSAPP: baseOpts.now.toISOString(),
    })
  })

  // An inbound message is DELIVERED (to us), not QUEUED (to send). This path
  // set neither, so it took the Message.status default of QUEUED — while its
  // sibling routeInbound, for the very same channel and direction, writes
  // DELIVERED. Whether we already knew the contact decided the status.
  // Harmless to the retry sweep, which selects RETRYING and documents that
  // QUEUED is not selected, but it puts received messages in every "waiting to
  // send" count: 3 of the 43 rows reported as a stuck outbound backlog on prod
  // were actually inbound.
  it("stores inbound as DELIVERED, not the QUEUED send-default", async () => {
    const tx = fakeTx()
    await handleWaStopInbound(tx as unknown as Parameters<typeof handleWaStopInbound>[0], {
      ...baseOpts, text: "hello",
    })
    expect(tx.message.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "DELIVERED", deliveredAt: baseOpts.now }),
      }),
    )
  })

  it("reuses an existing OPEN conversation and refreshes its lastInboundAt", async () => {
    const tx = fakeTx()
    tx.conversation.findFirst.mockResolvedValue({ id: "cnv_existing" })
    await handleWaStopInbound(tx as unknown as Parameters<typeof handleWaStopInbound>[0], baseOpts)
    expect(tx.conversation.create).not.toHaveBeenCalled()
    // lastActivityAt is the inbox queue's sort key and must move with every
    // lastInboundAt write, or a STOP lands on a thread that stops sorting by
    // its newest traffic.
    expect(tx.conversation.update).toHaveBeenCalledWith({
      where: { id: "cnv_existing" },
      data: { lastInboundAt: baseOpts.now, lastActivityAt: baseOpts.now },
    })
    expect(tx.message.create.mock.calls[0][0].data.conversationId).toBe("cnv_existing")
  })

  it("finds the open thread without a channel predicate", async () => {
    const tx = fakeTx()
    tx.conversation.findFirst.mockResolvedValue({ id: "cv1" })

    await handleWaStopInbound(tx as unknown as Parameters<typeof handleWaStopInbound>[0], baseOpts)

    const where = tx.conversation.findFirst.mock.calls[0][0].where
    expect(where).toEqual({ tenantId: "tenant_a", contactId: "ct_a", closedAt: null })
    expect(Object.keys(where)).not.toContain("channel")
  })

  it("stamps lastInboundAt on the reused thread", async () => {
    const tx = fakeTx()
    tx.conversation.findFirst.mockResolvedValue({ id: "cv1" })

    await handleWaStopInbound(tx as unknown as Parameters<typeof handleWaStopInbound>[0], baseOpts)

    expect(tx.conversation.update).toHaveBeenCalledWith({
      where: { id: "cv1" },
      data: { lastInboundAt: baseOpts.now, lastActivityAt: baseOpts.now },
    })
  })

  it("opens a WHATSAPP thread with lastInboundAt when none is open", async () => {
    const tx = fakeTx()
    tx.conversation.findFirst.mockResolvedValue(null)
    tx.conversation.create.mockResolvedValue({ id: "cv-new" })

    await handleWaStopInbound(tx as unknown as Parameters<typeof handleWaStopInbound>[0], baseOpts)

    const data = tx.conversation.create.mock.calls[0][0].data
    expect(data.channel).toBe("WHATSAPP")
    expect(data.lastInboundAt).toEqual(baseOpts.now)
    expect(tx.conversation.update).not.toHaveBeenCalled()
  })
})

describe("handleWaStopInbound — provider labelling", () => {
  function tx() {
    return {
      $queryRawUnsafe: vi.fn(async () => [{ id: "ct_a" }]),
      contactConsent: { updateMany: vi.fn(async () => ({ count: 0 })), create: vi.fn(async () => ({ id: "csn" })) },
      conversation: { findFirst: vi.fn(async () => ({ id: "cnv_1" })), create: vi.fn(), update: vi.fn(async () => ({ id: "cnv_1" })) },
      message: { create: vi.fn(async () => ({ id: "msg_1" })) },
      contact: { findUnique: vi.fn(async () => ({ lastInboundAtByChannel: null })), update: vi.fn(async () => ({ id: "ct_a" })) },
    }
  }
  const opts = {
    tenantId: "tenant_a",
    contact: { id: "ct_a", tenantId: "tenant_a" },
    fromValue: "27821234567@s.whatsapp.net",
    text: "hello",
    providerMessageId: "wamid.HBgL_p",
    provider: "WA_UNOFFICIAL" as const,
    now: new Date("2026-08-11T19:33:12.000Z"),
  }

  // Same defect as lib/inbox/routing.ts: this is the KNOWN-contact path, so it
  // mislabels the majority of Cloud inbound.
  it("stores the provider the caller passed", async () => {
    const t = tx()
    await handleWaStopInbound(t as unknown as Parameters<typeof handleWaStopInbound>[0], { ...opts, provider: "WA_CLOUD" })
    expect(t.message.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ provider: "WA_CLOUD" }) }),
    )
  })

  it("stores WA_UNOFFICIAL when the bridge webhook passes it", async () => {
    const t = tx()
    await handleWaStopInbound(t as unknown as Parameters<typeof handleWaStopInbound>[0], opts)
    expect(t.message.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ provider: "WA_UNOFFICIAL" }) }),
    )
  })
})
