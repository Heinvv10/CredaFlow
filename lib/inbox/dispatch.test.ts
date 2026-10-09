/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@/lib/prisma", () => ({
  prisma: {
    conversation: { findFirst: vi.fn(), update: vi.fn() },
    message: { findMany: vi.fn(), findFirst: vi.fn() },
    emailConfig: { findUnique: vi.fn() },
  },
}))
vi.mock("./settings", () => ({ getCommsSettings: vi.fn() }))
vi.mock("./reply-channels", () => ({ contactReplyChannels: vi.fn() }))
vi.mock("./agent-reply-template", () => ({ getOrCreateAgentReplyTemplate: vi.fn() }))
vi.mock("@/lib/website-chat/staff", () => ({ sendStaffChatReply: vi.fn() }))
vi.mock("@/lib/messaging/send", () => {
  class MessageReconciliationRequiredError extends Error {
    messageRecord: unknown
    constructor(messageRecord: unknown) { super("reconciliation required"); this.messageRecord = messageRecord }
  }
  class KnownDispatchPersistenceError extends MessageReconciliationRequiredError {
    outcome: "PROVIDER_ACCEPTED" | "SIMULATED"
    providerMessageId?: string
    evidenceReference?: string
    simulationReceiptId?: string
    constructor(args: {
      messageRecord: unknown
      outcome: "PROVIDER_ACCEPTED" | "SIMULATED"
      providerMessageId?: string
      evidenceReference?: string
      simulationReceiptId?: string
    }) {
      super(args.messageRecord)
      this.outcome = args.outcome
      this.providerMessageId = args.providerMessageId
      this.evidenceReference = args.evidenceReference
      this.simulationReceiptId = args.simulationReceiptId
    }
  }
  return {
    sendMessage: vi.fn(),
    SendBlockedError: class SendBlockedError extends Error {
      reason: string
      constructor(reason: string) { super(reason); this.reason = reason }
    },
    MessageReconciliationRequiredError,
    KnownDispatchPersistenceError,
    knownDispatchEvidenceFromError: (error: InstanceType<typeof KnownDispatchPersistenceError>) => ({
      outcome: error.outcome,
      ...(error.providerMessageId ? { providerMessageId: error.providerMessageId } : {}),
      ...(error.evidenceReference ? { evidenceReference: error.evidenceReference } : {}),
      ...(error.simulationReceiptId ? { simulationReceiptId: error.simulationReceiptId } : {}),
    }),
  }
})

import { dispatchAgentReply } from "./dispatch"
import { prisma } from "@/lib/prisma"
import { getCommsSettings } from "./settings"
import { contactReplyChannels } from "./reply-channels"
import { getOrCreateAgentReplyTemplate } from "./agent-reply-template"
import {
  KnownDispatchPersistenceError,
  MessageReconciliationRequiredError,
  sendMessage,
  SendBlockedError,
} from "@/lib/messaging/send"
import { ProviderDispatchError } from "@/lib/messaging/providers"
import { WA_OUTSIDE_WINDOW_NEEDS_TEMPLATE } from "@/lib/whatsapp/send-mode"
import { sendStaffChatReply } from "@/lib/website-chat/staff"

const input = {
  tenantId: "t1",
  conversationId: "cv1",
  agentUserId: "u1",
  text: "Hello there",
  operationId: "11111111-1111-4111-8111-111111111111",
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getCommsSettings).mockResolvedValue({ whatsappEnabled: true } as any)
  vi.mocked(prisma.conversation.findFirst).mockResolvedValue({
    id: "cv1", channel: "WHATSAPP", lastInboundAt: new Date(),
    contact: {
      id: "ct1", primaryWaJid: "27821234567@s.whatsapp.net", primaryPhone: "27821234567", primaryEmail: null,
      lastInboundAtByChannel: { WHATSAPP: new Date().toISOString() },
    },
  } as any)
  vi.mocked(getOrCreateAgentReplyTemplate).mockResolvedValue({ id: "tpl1", tenantId: "t1" } as any)
  vi.mocked(contactReplyChannels).mockResolvedValue(["WHATSAPP", "EMAIL"])
})

describe("dispatchAgentReply — WhatsApp", () => {
  it("blocks (CHANNEL_DISABLED) when WhatsApp is disabled", async () => {
    vi.mocked(getCommsSettings).mockResolvedValue({ whatsappEnabled: false } as any)
    const r = await dispatchAgentReply(input)
    expect(r).toEqual({ ok: false, reason: "CHANNEL_DISABLED", detail: "WhatsApp channel is disabled." })
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it("sends a free-form reply through sendMessage with the {{body}} template", async () => {
    vi.mocked(sendMessage).mockResolvedValue({ id: "m1", status: "SENT" } as any)
    const r = await dispatchAgentReply(input)
    expect(r).toEqual({ ok: true, message: { id: "m1", status: "SENT" }, outcome: "sent" })
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        contactId: "ct1",
        channel: "WHATSAPP",
        template: { id: "tpl1", tenantId: "t1" },
        vars: { body: "Hello there" },
        toValue: "27821234567@s.whatsapp.net",
        conversationId: "cv1",
        createdById: "u1",
        idempotencyKey: "agent-reply:cv1:WHATSAPP:11111111-1111-4111-8111-111111111111",
      }),
    )
    expect(getOrCreateAgentReplyTemplate).toHaveBeenCalledWith("t1", "WHATSAPP")
    expect(prisma.conversation.update).not.toHaveBeenCalled()
  })

  it("maps a consent block to SEND_BLOCKED", async () => {
    vi.mocked(sendMessage).mockRejectedValue(new SendBlockedError("CHANNEL_OPTED_OUT"))
    const r = await dispatchAgentReply(input)
    expect(r).toEqual({ ok: false, reason: "SEND_BLOCKED", detail: "CHANNEL_OPTED_OUT" })
  })

  it("surfaces a held provider outcome without permitting a duplicate reply", async () => {
    const held = { id: "m-held", status: "QUEUED", conversationId: "cv1" }
    vi.mocked(sendMessage).mockRejectedValue(new MessageReconciliationRequiredError(held as any))

    const result = await dispatchAgentReply(input)

    expect(result).toEqual({ ok: true, message: held, outcome: "pending", reconciliationRequired: true })
    expect(prisma.conversation.update).not.toHaveBeenCalled()
  })

  it("preserves known provider evidence for the reconciliation workflow", async () => {
    const held = { id: "m-known", status: "QUEUED", conversationId: "cv1" }
    vi.mocked(sendMessage).mockRejectedValue(new KnownDispatchPersistenceError({
      messageRecord: held,
      outcome: "PROVIDER_ACCEPTED",
      evidenceReference: "MSGRAPH_CLIENT_REQUEST_ID:accepted",
    } as any))

    await expect(dispatchAgentReply(input)).resolves.toEqual({
      ok: true,
      message: held,
      outcome: "pending",
      reconciliationRequired: true,
      knownDispatchEvidence: {
        outcome: "PROVIDER_ACCEPTED",
        evidenceReference: "MSGRAPH_CLIENT_REQUEST_ID:accepted",
      },
    })
    expect(prisma.conversation.update).not.toHaveBeenCalled()
  })

  it.each(["FAILED_PERMANENT", "EXPIRED", "SUPPRESSED_BY_CONSENT"] as const)(
    "returns ok:false and preserves lastOutboundAt for terminal %s",
    async (status) => {
      vi.mocked(sendMessage).mockResolvedValue({ id: "m-terminal", status } as any)

      const result = await dispatchAgentReply(input)

      expect(result).toEqual({
        ok: false,
        reason: "SEND_FAILED",
        detail: `Message m-terminal is ${status} and was not sent.`,
      })
      expect(prisma.conversation.update).not.toHaveBeenCalled()
    },
  )

  it.each([
    ["RETRYING", "pending"],
    ["SIMULATED", "simulated"],
  ] as const)("projects %s as %s without claiming an outbound timestamp", async (status, outcome) => {
    vi.mocked(sendMessage).mockResolvedValue({ id: "m-state", status } as any)

    const result = await dispatchAgentReply(input)

    expect(result).toMatchObject({ ok: true, outcome, message: { status } })
    expect(prisma.conversation.update).not.toHaveBeenCalled()
  })

  it("maps the outside-window provider failure to OUTSIDE_WINDOW (sendMessage rejects)", async () => {
    vi.mocked(sendMessage).mockRejectedValue(
      new ProviderDispatchError(WA_OUTSIDE_WINDOW_NEEDS_TEMPLATE, "DEFINITELY_REJECTED"),
    )
    const r = await dispatchAgentReply(input)
    expect(r).toEqual({
      ok: false,
      reason: "OUTSIDE_WINDOW",
      detail: "This contact is outside the 24h WhatsApp window — pick an approved template to reply.",
    })
  })

  // Defensive: some automatic-retry channels resolve a durable FAILED_PERMANENT
  // Message rather than throwing (see lib/messaging/send.ts). Cover that shape
  // too, keyed off errorMessage carrying the same code.
  it("maps the outside-window provider failure to OUTSIDE_WINDOW (sendMessage resolves FAILED_PERMANENT)", async () => {
    vi.mocked(sendMessage).mockResolvedValue({
      id: "m-outside-window",
      status: "FAILED_PERMANENT",
      errorMessage: WA_OUTSIDE_WINDOW_NEEDS_TEMPLATE,
    } as any)
    const r = await dispatchAgentReply(input)
    expect(r).toEqual({
      ok: false,
      reason: "OUTSIDE_WINDOW",
      detail: "This contact is outside the 24h WhatsApp window — pick an approved template to reply.",
    })
  })

  it("errors when the contact has no WhatsApp destination", async () => {
    vi.mocked(prisma.conversation.findFirst).mockResolvedValue({
      id: "cv1", channel: "WHATSAPP", lastInboundAt: new Date(),
      contact: {
        id: "ct1", primaryWaJid: null, primaryPhone: null, primaryEmail: null,
        lastInboundAtByChannel: { WHATSAPP: new Date().toISOString() },
      },
    } as any)
    const r = await dispatchAgentReply(input)
    expect(r.ok).toBe(false)
    expect((r as any).reason).toBe("NO_DESTINATION")
    expect(sendMessage).not.toHaveBeenCalled()
  })
})

describe("dispatchAgentReply — Email", () => {
  beforeEach(() => {
    vi.mocked(prisma.conversation.findFirst).mockResolvedValue({
      id: "cv1", channel: "EMAIL", contact: { id: "ct1", primaryWaJid: null, primaryPhone: null, primaryEmail: "cust@example.com" },
    } as any)
    vi.mocked(prisma.emailConfig.findUnique).mockResolvedValue({ active: true, provider: "IMAP_SMTP" } as any)
    vi.mocked(prisma.message.findMany).mockResolvedValue([
      { direction: "INBOUND", providerMessageId: "<c1@mail>", subject: "Loan question" },
      { direction: "OUTBOUND", providerMessageId: "<a1@acme>", subject: "Re: Loan question" },
      { direction: "INBOUND", providerMessageId: "<c2@mail>", subject: "Re: Loan question" },
    ] as any)
    vi.mocked(sendMessage).mockResolvedValue({ id: "m1", status: "SENT" } as any)
  })

  it("threads the reply: In-Reply-To = last inbound id, References = full chain, Re: subject", async () => {
    const r = await dispatchAgentReply({ ...input, text: "Thanks <you> &\nregards" })
    expect(r).toEqual({ ok: true, message: { id: "m1", status: "SENT" }, outcome: "sent" })
    expect(getOrCreateAgentReplyTemplate).toHaveBeenCalledWith("t1", "EMAIL")
    const sent = vi.mocked(sendMessage).mock.calls[0][0]
    expect(sent).toMatchObject({
      contactId: "ct1",
      channel: "EMAIL",
      toValue: "cust@example.com",
      conversationId: "cv1",
      createdById: "u1",
      category: "agent_reply",
      inReplyTo: "<c2@mail>",
      references: ["<c1@mail>", "<a1@acme>", "<c2@mail>"],
      idempotencyKey: "agent-reply:cv1:EMAIL:11111111-1111-4111-8111-111111111111",
    })
    expect(sent.vars).toEqual({
      subject: "Re: Loan question",
      body: "Thanks <you> &\nregards",
      // escaped + newline→<br> so the HTML email keeps breaks and renders `<`/`&` as text
      bodyHtml: "Thanks &lt;you&gt; &amp;<br>regards",
    })
    expect(prisma.conversation.update).not.toHaveBeenCalled()
  })

  it("adds a Re: prefix when the source subject lacks one", async () => {
    vi.mocked(prisma.message.findMany).mockResolvedValue([
      { direction: "INBOUND", providerMessageId: "<c1@mail>", subject: "Balance please" },
    ] as any)
    await dispatchAgentReply(input)
    expect(vi.mocked(sendMessage).mock.calls[0][0].vars.subject).toBe("Re: Balance please")
  })

  it("sends without threading headers when the thread has no prior email ids", async () => {
    vi.mocked(prisma.message.findMany).mockResolvedValue([] as any)
    await dispatchAgentReply(input)
    const sent = vi.mocked(sendMessage).mock.calls[0][0]
    expect(sent.inReplyTo).toBeUndefined()
    expect(sent.references).toBeUndefined()
    expect(sent.vars.subject).toBe("Re: your message")
  })

  it("gates MS Graph tenants (synthetic Message-ID can't thread yet)", async () => {
    vi.mocked(prisma.emailConfig.findUnique).mockResolvedValue({ active: true, provider: "MSGRAPH" } as any)
    const r = await dispatchAgentReply(input)
    expect(r.ok).toBe(false)
    expect((r as any).reason).toBe("CHANNEL_DISABLED")
    expect((r as any).detail).toMatch(/SMTP/)
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it("blocks when email is not configured / inactive", async () => {
    vi.mocked(prisma.emailConfig.findUnique).mockResolvedValue(null as any)
    const r = await dispatchAgentReply(input)
    expect(r).toEqual({ ok: false, reason: "CHANNEL_DISABLED", detail: "Email is not configured for this tenant." })
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it("errors when the contact has no email destination", async () => {
    vi.mocked(prisma.conversation.findFirst).mockResolvedValue({
      id: "cv1", channel: "EMAIL", contact: { id: "ct1", primaryWaJid: null, primaryPhone: null, primaryEmail: null },
    } as any)
    const r = await dispatchAgentReply(input)
    expect((r as any).reason).toBe("NO_DESTINATION")
    expect(sendMessage).not.toHaveBeenCalled()
  })
})

describe("dispatchAgentReply — guards", () => {
  it("returns CONVERSATION_NOT_FOUND when the conversation is missing", async () => {
    vi.mocked(prisma.conversation.findFirst).mockResolvedValue(null as any)
    const r = await dispatchAgentReply(input)
    expect(r).toEqual({ ok: false, reason: "CONVERSATION_NOT_FOUND" })
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it("refuses unsupported channels (e.g. SMS) with a channel-neutral reason", async () => {
    vi.mocked(prisma.conversation.findFirst).mockResolvedValue({
      id: "cv1", channel: "SMS", contact: { id: "ct1", primaryWaJid: null, primaryPhone: "27820000000", primaryEmail: null },
    } as any)
    const r = await dispatchAgentReply(input)
    expect(r.ok).toBe(false)
    expect((r as any).reason).toBe("CHANNEL_DISABLED")
    expect((r as any).detail).toMatch(/SMS/)
    expect(sendMessage).not.toHaveBeenCalled()
  })
})

describe("dispatchAgentReply — website chat", () => {
  beforeEach(() => {
    vi.mocked(prisma.conversation.findFirst).mockResolvedValue({
      id: "cv1", channel: "CHATBOT", lastInboundAt: new Date(),
      contact: { id: "ct1", primaryWaJid: null, primaryPhone: null, primaryEmail: "a@b.co", lastInboundAtByChannel: null },
    } as any)
  })

  it("writes the reply into the chat window as the agent, whatever channel is asked for, and sends nothing", async () => {
    const message = { id: "m1", status: "DELIVERED" }
    vi.mocked(sendStaffChatReply).mockResolvedValue({ ok: true, message } as any)
    const r = await dispatchAgentReply({ ...input, channel: "EMAIL" })
    expect(r).toEqual({ ok: true, message, outcome: "sent" })
    expect(sendStaffChatReply).toHaveBeenCalledWith({ tenantId: "t1", conversationId: "cv1", staffUserId: "u1", staffEmail: undefined, text: "Hello there", now: expect.any(Date), idempotencyKey: expect.any(String) })
    // The caller's email rides through to the reply's audit row.
    await dispatchAgentReply({ ...input, agentEmail: "thandi@acme-lending.example" })
    expect(vi.mocked(sendStaffChatReply).mock.calls.at(-1)?.[0]).toMatchObject({ staffUserId: "u1", staffEmail: "thandi@acme-lending.example" })
    expect(sendMessage).not.toHaveBeenCalled()
    expect(contactReplyChannels).not.toHaveBeenCalled()
  })

  it.each([
    ["NOT_JOINED", { ok: false, reason: "CHANNEL_DISABLED", detail: "Join the chat before replying." }],
    ["CLOSED", { ok: false, reason: "CHANNEL_DISABLED", detail: "This chat has ended." }],
    ["CONVERSATION_NOT_FOUND", { ok: false, reason: "CONVERSATION_NOT_FOUND" }],
    ["TOO_LONG", { ok: false, reason: "SEND_FAILED", detail: "Replies are limited to 2000 characters." }],
    ["EMPTY", { ok: false, reason: "SEND_FAILED", detail: "Type a message first." }],
  ] as const)("maps %s from the chat", async (reason, expected) => {
    vi.mocked(sendStaffChatReply).mockResolvedValue({ ok: false, reason })
    expect(await dispatchAgentReply(input)).toEqual(expected)
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it("passes the composer's operation as the idempotency key, and none when there is no operation", async () => {
    vi.mocked(sendStaffChatReply).mockResolvedValue({ ok: true, message: { id: "m1" } } as any)
    await dispatchAgentReply(input)
    expect(vi.mocked(sendStaffChatReply).mock.calls[0][0].idempotencyKey).toBe("agent-reply:cv1:CHATBOT:11111111-1111-4111-8111-111111111111")
    await dispatchAgentReply({ ...input, operationId: undefined })
    expect(vi.mocked(sendStaffChatReply).mock.calls[1][0].idempotencyKey).toBeUndefined()
  })
})

describe("per-reply channel", () => {
  const contact = {
    id: "ct1", primaryWaJid: "27821234567@s.whatsapp.net", primaryPhone: "27821234567",
    primaryEmail: "person@example.test", lastInboundAtByChannel: null,
  }

  it("uses the requested channel over Conversation.channel", async () => {
    vi.mocked(prisma.conversation.findFirst).mockResolvedValue({
      id: "cv1", channel: "WHATSAPP", lastInboundAt: null, contact,
    } as never)
    vi.mocked(contactReplyChannels).mockResolvedValue(["WHATSAPP", "EMAIL"])
    vi.mocked(prisma.emailConfig.findUnique).mockResolvedValue({ active: true, provider: "IMAP_SMTP" } as never)
    vi.mocked(prisma.message.findMany).mockResolvedValue([] as never)
    vi.mocked(getOrCreateAgentReplyTemplate).mockResolvedValue({ id: "tpl", tenantId: "t1" } as never)
    vi.mocked(sendMessage).mockResolvedValue({ id: "m1", status: "SENT" } as never)

    const r = await dispatchAgentReply({ ...input, channel: "EMAIL" })

    expect(r.ok).toBe(true)
    expect(vi.mocked(sendMessage).mock.calls[0][0].channel).toBe("EMAIL")
  })

  it("defaults to the channel of the latest inbound message", async () => {
    vi.mocked(prisma.conversation.findFirst).mockResolvedValue({
      id: "cv1", channel: "WHATSAPP", lastInboundAt: null, contact,
    } as never)
    vi.mocked(prisma.message.findFirst).mockResolvedValue({ channel: "EMAIL" } as never)
    vi.mocked(contactReplyChannels).mockResolvedValue(["WHATSAPP", "EMAIL"])
    vi.mocked(prisma.emailConfig.findUnique).mockResolvedValue({ active: true, provider: "IMAP_SMTP" } as never)
    vi.mocked(prisma.message.findMany).mockResolvedValue([] as never)
    vi.mocked(getOrCreateAgentReplyTemplate).mockResolvedValue({ id: "tpl", tenantId: "t1" } as never)
    vi.mocked(sendMessage).mockResolvedValue({ id: "m1", status: "SENT" } as never)

    await dispatchAgentReply(input)

    expect(vi.mocked(sendMessage).mock.calls[0][0].channel).toBe("EMAIL")
  })

  it("falls back to Conversation.channel when the thread has no inbound", async () => {
    // Conversation.channel is EMAIL here (not WHATSAPP) so this fixture can pass
    // the WA window gate honestly: an EMAIL fallback never touches computeWaWindow,
    // so it doesn't need a fabricated fresh WhatsApp timestamp to succeed.
    vi.mocked(prisma.conversation.findFirst).mockResolvedValue({
      id: "cv1", channel: "EMAIL", lastInboundAt: null,
      contact: { ...contact, lastInboundAtByChannel: null },
    } as never)
    vi.mocked(prisma.message.findFirst).mockResolvedValue(null as never)
    vi.mocked(contactReplyChannels).mockResolvedValue(["WHATSAPP", "EMAIL"])
    vi.mocked(prisma.emailConfig.findUnique).mockResolvedValue({ active: true, provider: "IMAP_SMTP" } as never)
    vi.mocked(prisma.message.findMany).mockResolvedValue([] as never)
    vi.mocked(getOrCreateAgentReplyTemplate).mockResolvedValue({ id: "tpl", tenantId: "t1" } as never)
    vi.mocked(sendMessage).mockResolvedValue({ id: "m1", status: "SENT" } as never)

    await dispatchAgentReply(input)

    expect(vi.mocked(sendMessage).mock.calls[0][0].channel).toBe("EMAIL")
  })

  it("rejects a channel the contact has no identity for", async () => {
    vi.mocked(prisma.conversation.findFirst).mockResolvedValue({
      id: "cv1", channel: "WHATSAPP", lastInboundAt: null, contact,
    } as never)
    vi.mocked(contactReplyChannels).mockResolvedValue([])

    const r = await dispatchAgentReply({ ...input, channel: "EMAIL" })

    expect(r).toEqual({ ok: false, reason: "NO_DESTINATION", detail: "This contact has no email identity on file." })
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it("rejects a free-text WhatsApp reply outside the 24h window", async () => {
    const stale = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString()
    vi.mocked(prisma.conversation.findFirst).mockResolvedValue({
      id: "cv1", channel: "WHATSAPP", lastInboundAt: new Date(stale),
      contact: { ...contact, lastInboundAtByChannel: { WHATSAPP: stale } },
    } as never)
    vi.mocked(contactReplyChannels).mockResolvedValue(["WHATSAPP", "EMAIL"])

    const r = await dispatchAgentReply({ ...input, channel: "WHATSAPP" })

    expect(r.ok).toBe(false)
    expect(r).toMatchObject({ reason: "OUTSIDE_WINDOW" })
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it("rejects WhatsApp when Conversation.lastInboundAt is fresh but lastInboundAtByChannel has no WHATSAPP entry", async () => {
    // Conversation.lastInboundAt is channel-agnostic (email inbound writes it
    // too), so it must never rescue the window check. Only
    // lastInboundAtByChannel.WHATSAPP counts.
    vi.mocked(prisma.conversation.findFirst).mockResolvedValue({
      id: "cv1", channel: "WHATSAPP", lastInboundAt: new Date(),
      contact: { ...contact, lastInboundAtByChannel: {} },
    } as never)
    vi.mocked(contactReplyChannels).mockResolvedValue(["WHATSAPP", "EMAIL"])

    const r = await dispatchAgentReply({ ...input, channel: "WHATSAPP" })

    expect(r).toMatchObject({ ok: false, reason: "OUTSIDE_WINDOW" })
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it("allows a WhatsApp reply inside the window", async () => {
    const fresh = new Date(Date.now() - 60 * 1000).toISOString()
    vi.mocked(prisma.conversation.findFirst).mockResolvedValue({
      id: "cv1", channel: "WHATSAPP", lastInboundAt: new Date(fresh),
      contact: { ...contact, lastInboundAtByChannel: { WHATSAPP: fresh } },
    } as never)
    vi.mocked(contactReplyChannels).mockResolvedValue(["WHATSAPP", "EMAIL"])
    vi.mocked(getCommsSettings).mockResolvedValue({ whatsappEnabled: true } as never)
    vi.mocked(getOrCreateAgentReplyTemplate).mockResolvedValue({ id: "tpl", tenantId: "t1" } as never)
    vi.mocked(sendMessage).mockResolvedValue({ id: "m1", status: "SENT" } as never)

    const r = await dispatchAgentReply({ ...input, channel: "WHATSAPP" })

    expect(r.ok).toBe(true)
  })
})
