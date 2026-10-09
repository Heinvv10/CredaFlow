/* eslint-disable @typescript-eslint/no-explicit-any */
// vi.fn() mock resolved values don't match full Prisma return types — the
// partial shapes returned here are sufficient for the unit under test and the
// `as any` boundary keeps the mocks readable without duplicating every column.
import { describe, it, expect, beforeEach, vi } from "vitest"

vi.mock("@/lib/prisma", () => ({
  prisma: { contact: { findFirst: vi.fn() } },
}))
vi.mock("@/lib/config/identity", () => ({ getLenderIdentity: async () => ({ tradingName: "Acme Lending" }) }))
vi.mock("@/lib/inbox/settings", () => ({ getCommsSettings: vi.fn() }))
vi.mock("./channel-availability", () => ({ getChannelAvailability: vi.fn() }))
vi.mock("./agent-message-template", () => ({ getOrCreateAgentMessageTemplate: vi.fn() }))
vi.mock("./send", () => {
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

import { sendAgentMessage } from "./agent-message"
import { prisma } from "@/lib/prisma"
import { getCommsSettings } from "@/lib/inbox/settings"
import { getChannelAvailability } from "./channel-availability"
import { getOrCreateAgentMessageTemplate } from "./agent-message-template"
import { KnownDispatchPersistenceError, sendMessage, SendBlockedError } from "./send"

const contact = {
  id: "ct1",
  primaryEmail: "a@b.com",
  primaryPhone: "+27821234567",
  primaryWaJid: "27821234567@s.whatsapp.net",
  blockedAt: null,
  status: "CLIENT",
}

const baseInput = {
  tenantId: "t1",
  contactId: "ct1",
  agentUserId: "u1",
  text: "Hello there",
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(prisma.contact.findFirst).mockResolvedValue(contact as any)
  vi.mocked(getCommsSettings).mockResolvedValue({ whatsappEnabled: true } as any)
  vi.mocked(getChannelAvailability).mockResolvedValue({
    EMAIL: { enabled: true, toValue: "a@b.com" },
    WHATSAPP: { enabled: true, toValue: "27821234567@s.whatsapp.net" },
    SMS: { enabled: true, toValue: "+27821234567" },
  } as any)
  vi.mocked(getOrCreateAgentMessageTemplate).mockResolvedValue({ id: "tpl1", tenantId: "t1" } as any)
})

describe("sendAgentMessage", () => {
  it("EMAIL happy path: sends with subject/body vars + attachments, returns ok:true", async () => {
    vi.mocked(sendMessage).mockResolvedValue({ id: "m1", conversationId: "cv1", status: "SENT" } as any)
    const attachments = [{ filename: "a.pdf", content: Buffer.from("x"), contentType: "application/pdf" }]

    const r = await sendAgentMessage({
      ...baseInput,
      channel: "EMAIL",
      subject: "Custom subject",
      attachments,
    })

    expect(r).toEqual({ ok: true, messageId: "m1", conversationId: "cv1", status: "SENT", outcome: "sent" })
    expect(getOrCreateAgentMessageTemplate).toHaveBeenCalledWith("t1", "EMAIL")
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        contactId: "ct1",
        channel: "EMAIL",
        template: { id: "tpl1", tenantId: "t1" },
        vars: { subject: "Custom subject", body: "Hello there", bodyHtml: "Hello there" },
        toValue: "a@b.com",
        createdById: "u1",
        category: "agent_message",
        attachments,
      }),
    )
  })

  it("EMAIL happy path defaults subject when none supplied", async () => {
    vi.mocked(sendMessage).mockResolvedValue({ id: "m1", conversationId: "cv1", status: "SENT" } as any)

    await sendAgentMessage({ ...baseInput, channel: "EMAIL" })

    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        vars: { subject: "A message from Acme Lending", body: "Hello there", bodyHtml: "Hello there" },
      }),
    )
  })

  it("WHATSAPP happy path: body-only vars, attachments omitted", async () => {
    vi.mocked(sendMessage).mockResolvedValue({ id: "m2", conversationId: "cv2", status: "SENT" } as any)

    const r = await sendAgentMessage({ ...baseInput, channel: "WHATSAPP" })

    expect(r).toEqual({ ok: true, messageId: "m2", conversationId: "cv2", status: "SENT", outcome: "sent" })
    expect(getOrCreateAgentMessageTemplate).toHaveBeenCalledWith("t1", "WHATSAPP")
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        contactId: "ct1",
        channel: "WHATSAPP",
        vars: { body: "Hello there" },
        toValue: "27821234567@s.whatsapp.net",
        attachments: undefined,
      }),
    )
  })

  it("binds a staff operation id to a durable per-contact/channel reservation", async () => {
    vi.mocked(sendMessage).mockResolvedValue({ id: "m-op", conversationId: "cv-op", status: "SENT" } as any)

    await sendAgentMessage({
      ...baseInput,
      channel: "SMS",
      operationId: "11111111-1111-4111-8111-111111111111",
    })

    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: "agent-message:ct1:SMS:11111111-1111-4111-8111-111111111111",
    }))
  })

  it("disabled channel: returns NO_DESTINATION with the availability reason as detail, does not send", async () => {
    vi.mocked(getChannelAvailability).mockResolvedValue({
      EMAIL: { enabled: true, toValue: "a@b.com" },
      WHATSAPP: { enabled: false, reason: "Client opted out" },
      SMS: { enabled: true, toValue: "+27821234567" },
    } as any)

    const r = await sendAgentMessage({ ...baseInput, channel: "WHATSAPP" })

    expect(r).toEqual({ ok: false, reason: "NO_DESTINATION", detail: "Client opted out" })
    expect(sendMessage).not.toHaveBeenCalled()
    expect(getOrCreateAgentMessageTemplate).not.toHaveBeenCalled()
  })

  it("SendBlockedError from sendMessage maps to SEND_BLOCKED", async () => {
    vi.mocked(sendMessage).mockRejectedValue(new SendBlockedError("CHANNEL_OPTED_OUT"))

    const r = await sendAgentMessage({ ...baseInput, channel: "SMS" })

    expect(r).toEqual({ ok: false, reason: "SEND_BLOCKED", detail: "CHANNEL_OPTED_OUT" })
  })

  it("generic Error from sendMessage maps to SEND_FAILED without throwing", async () => {
    vi.mocked(sendMessage).mockRejectedValue(new Error("provider exploded"))

    const r = await sendAgentMessage({ ...baseInput, channel: "EMAIL" })

    expect(r.ok).toBe(false)
    expect((r as any).reason).toBe("SEND_FAILED")
    expect((r as any).detail).not.toContain("provider exploded")
  })

  it("preserves known provider evidence for the reconciliation workflow", async () => {
    vi.mocked(sendMessage).mockRejectedValue(new KnownDispatchPersistenceError({
      messageRecord: { id: "m-known", conversationId: "cv1", status: "QUEUED" } as any,
      outcome: "PROVIDER_ACCEPTED",
      providerMessageId: "provider-accepted-1",
    } as any))

    await expect(sendAgentMessage({ ...baseInput, channel: "EMAIL" })).resolves.toEqual({
      ok: true,
      messageId: "m-known",
      conversationId: "cv1",
      status: "QUEUED",
      outcome: "pending",
      reconciliationRequired: true,
      knownDispatchEvidence: {
        outcome: "PROVIDER_ACCEPTED",
        providerMessageId: "provider-accepted-1",
      },
    })
  })

  it.each(["FAILED_PERMANENT", "EXPIRED", "SUPPRESSED_BY_CONSENT"] as const)(
    "returns ok:false when an idempotent retry finds terminal %s",
    async (status) => {
      vi.mocked(sendMessage).mockResolvedValue({ id: "m-terminal", conversationId: "cv1", status } as any)

      const r = await sendAgentMessage({ ...baseInput, channel: "SMS" })

      expect(r).toEqual({
        ok: false,
        reason: "SEND_FAILED",
        detail: `Message m-terminal is ${status} and was not sent.`,
      })
    },
  )

  it.each([
    ["RETRYING", "pending"],
    ["SIMULATED", "simulated"],
  ] as const)("projects %s explicitly as %s", async (status, outcome) => {
    vi.mocked(sendMessage).mockResolvedValue({ id: "m-state", conversationId: "cv1", status } as any)

    const r = await sendAgentMessage({ ...baseInput, channel: "SMS" })

    expect(r).toMatchObject({ ok: true, status, outcome })
  })

  it("EMAIL: bodyHtml var is HTML-escaped with newlines converted to <br>, body var stays raw", async () => {
    vi.mocked(sendMessage).mockResolvedValue({ id: "m4", conversationId: "cv4", status: "SENT" } as any)

    await sendAgentMessage({ ...baseInput, channel: "EMAIL", text: "Hello <b>there</b>\nSecond line" })

    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        vars: {
          subject: "A message from Acme Lending",
          body: "Hello <b>there</b>\nSecond line",
          bodyHtml: "Hello &lt;b&gt;there&lt;/b&gt;<br>Second line",
        },
      }),
    )
  })

  it("rejects attachments on WHATSAPP without calling sendMessage", async () => {
    const attachments = [{ filename: "a.pdf", content: Buffer.from("x"), contentType: "application/pdf" }]

    const r = await sendAgentMessage({ ...baseInput, channel: "WHATSAPP", attachments })

    expect(r.ok).toBe(false)
    expect((r as any).reason).toBe("NO_DESTINATION")
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it("rejects attachments on SMS without calling sendMessage", async () => {
    const attachments = [{ filename: "a.pdf", content: Buffer.from("x"), contentType: "application/pdf" }]

    const r = await sendAgentMessage({ ...baseInput, channel: "SMS", attachments })

    expect(r.ok).toBe(false)
    expect((r as any).reason).toBe("NO_DESTINATION")
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it("passes loanId through to sendMessage when provided", async () => {
    vi.mocked(sendMessage).mockResolvedValue({ id: "m3", conversationId: "cv3", status: "SENT" } as any)

    await sendAgentMessage({ ...baseInput, channel: "SMS", loanId: "loan1" })

    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ loanId: "loan1" }))
  })

  it("returns NO_DESTINATION when the contact does not exist", async () => {
    vi.mocked(prisma.contact.findFirst).mockResolvedValue(null as any)

    const r = await sendAgentMessage({ ...baseInput, channel: "EMAIL" })

    expect(r.ok).toBe(false)
    expect((r as any).reason).toBe("NO_DESTINATION")
    expect(sendMessage).not.toHaveBeenCalled()
  })
})
