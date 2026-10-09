import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"
import type { Message } from "@prisma/client"

const requireApiRoleMock = vi.fn()
const withTenantContextMock = vi.fn()
const contactFindFirstMock = vi.fn()
const leadFindFirstMock = vi.fn()
const crmActivityCreateMock = vi.fn()
const sendMessageMock = vi.fn()
const getOrCreateAgentMessageTemplateMock = vi.fn()

vi.mock("@/lib/auth-guards", () => ({ requireApiRole: () => requireApiRoleMock() }))
vi.mock("@/lib/tenant", () => ({
  withTenantContext: (req: unknown, cb: (t: { id: string }) => Promise<unknown>) =>
    withTenantContextMock(req, cb),
}))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    contact: { findFirst: (a: unknown) => contactFindFirstMock(a) },
    lead: { findFirst: (a: unknown) => leadFindFirstMock(a) },
    crmActivity: { create: (a: unknown) => crmActivityCreateMock(a) },
  },
}))
vi.mock("@/lib/messaging/send", () => {
  class MessageReconciliationRequiredError extends Error {
    messageRecord: unknown
    constructor(messageRecord: unknown) { super("reconciliation required"); this.messageRecord = messageRecord }
  }
  class KnownDispatchPersistenceError extends MessageReconciliationRequiredError {
    outcome: "PROVIDER_ACCEPTED" | "SIMULATED"
    providerMessageId?: string
    constructor(args: { message: unknown; outcome: "PROVIDER_ACCEPTED" | "SIMULATED"; providerMessageId?: string }) {
      super(args.message)
      this.outcome = args.outcome
      this.providerMessageId = args.providerMessageId
    }
  }
  return {
    sendMessage: (a: unknown) => sendMessageMock(a),
    SendBlockedError: class SendBlockedError extends Error {
      reason: string
      constructor(reason: string) { super(reason); this.reason = reason }
    },
    MessageReconciliationRequiredError,
    KnownDispatchPersistenceError,
    knownDispatchEvidenceFromError: (error: InstanceType<typeof KnownDispatchPersistenceError>) => ({
      outcome: error.outcome,
      ...(error.providerMessageId ? { providerMessageId: error.providerMessageId } : {}),
    }),
  }
})
vi.mock("@/lib/messaging/agent-message-template", () => ({
  getOrCreateAgentMessageTemplate: (...args: unknown[]) => getOrCreateAgentMessageTemplateMock(...args),
}))

import { POST } from "./route"
import {
  KnownDispatchPersistenceError,
  MessageReconciliationRequiredError,
  SendBlockedError,
} from "@/lib/messaging/send"

const OPERATION_ID = "11111111-1111-4111-8111-111111111111"
function makeReq(body: Record<string, unknown>) {
  return new NextRequest("http://x/api/crm/whatsapp/send", {
    method: "POST",
    body: JSON.stringify({ operationId: OPERATION_ID, ...body }),
  })
}

const contact = { id: "ct1", primaryWaJid: "27821234567@s.whatsapp.net", primaryPhone: "27821234567" }

beforeEach(() => {
  vi.clearAllMocks()
  requireApiRoleMock.mockResolvedValue({ user: { id: "u1", email: "o@x", name: "Officer" } })
  withTenantContextMock.mockImplementation((_req: unknown, cb: (t: { id: string }) => Promise<unknown>) =>
    cb({ id: "t1" }))
  contactFindFirstMock.mockResolvedValue(contact)
  getOrCreateAgentMessageTemplateMock.mockResolvedValue({ id: "tpl1", tenantId: "t1" })
  leadFindFirstMock.mockResolvedValue(null)
  crmActivityCreateMock.mockResolvedValue({ id: "act1" })
})

describe("POST /api/crm/whatsapp/send", () => {
  it("clientId flow: sends through sendMessage(), no direct provider call, returns messageId", async () => {
    sendMessageMock.mockResolvedValue({ id: "m1", status: "SENT" })

    const res = await POST(makeReq({ clientId: "c1", message: "hello" }))
    const json = await res.json() as { ok: boolean; messageId: string }

    expect(res.status).toBe(200)
    expect(json).toEqual({
      ok: true,
      messageId: "m1",
      simulated: false,
      sent: true,
      pending: false,
      reconciliationRequired: false,
    })
    expect(contactFindFirstMock).toHaveBeenCalledWith({ where: { tenantId: "t1", clientId: "c1" } })
    expect(sendMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        contactId: "ct1",
        channel: "WHATSAPP",
        vars: { body: "hello" },
        toValue: "27821234567@s.whatsapp.net",
        category: "manual_whatsapp",
        createdById: "u1",
        idempotencyKey: `manual-whatsapp:ct1:${OPERATION_ID}`,
      }),
    )
  })

  it("leadId flow (pre-conversion, no Client row): resolves Contact by leadId", async () => {
    sendMessageMock.mockResolvedValue({ id: "m2", status: "SENT" })

    const res = await POST(makeReq({ leadId: "l1", message: "hi lead" }))
    const json = await res.json() as { ok: boolean }

    expect(res.status).toBe(200)
    expect(json.ok).toBe(true)
    expect(contactFindFirstMock).toHaveBeenCalledWith({ where: { tenantId: "t1", leadId: "l1" } })
  })

  it("KEEPS the CrmActivity side-write when the client has an associated lead", async () => {
    sendMessageMock.mockResolvedValue({ id: "m3", status: "SENT" })
    leadFindFirstMock.mockResolvedValue({ id: "lead9" })

    await POST(makeReq({ clientId: "c1", message: "hello" }))

    expect(crmActivityCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          leadId: "lead9",
          clientId: "c1",
          type: "WHATSAPP",
        }),
      }),
    )
  })

  it("leadId flow: CrmActivity uses the supplied leadId directly (no lookup needed)", async () => {
    sendMessageMock.mockResolvedValue({ id: "m4", status: "SENT" })

    await POST(makeReq({ leadId: "l1", message: "hi" }))

    expect(leadFindFirstMock).not.toHaveBeenCalled()
    expect(crmActivityCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ leadId: "l1" }) }),
    )
  })

  it("returns and records a dry-run as simulated, never sent", async () => {
    sendMessageMock.mockResolvedValue({ id: "m-sim", status: "SIMULATED" })

    const res = await POST(makeReq({ leadId: "l1", message: "hi" }))

    await expect(res.json()).resolves.toMatchObject({ ok: true, simulated: true })
    expect(crmActivityCreateMock).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ subject: expect.stringContaining("simulated (not sent)") }),
    }))
  })

  it("eligibility block: surfaces as 422, not a fake success", async () => {
    sendMessageMock.mockRejectedValue(new SendBlockedError("CHANNEL_OPTED_OUT"))

    const res = await POST(makeReq({ clientId: "c1", message: "hello" }))
    const json = await res.json() as { error: string }

    expect(res.status).toBe(422)
    expect(json.error).toContain("CHANNEL_OPTED_OUT")
    expect(crmActivityCreateMock).not.toHaveBeenCalled()
  })

  it("dispatch failure: surfaces as 500, not a fake success", async () => {
    sendMessageMock.mockRejectedValue(new Error("provider down"))

    const res = await POST(makeReq({ clientId: "c1", message: "hello" }))
    const json = await res.json() as { error: string }

    expect(res.status).toBe(500)
    expect(json.error).toBe("provider down")
  })

  it("an ambiguous provider outcome is explicit and cannot be presented as sent", async () => {
    sendMessageMock.mockRejectedValue(new MessageReconciliationRequiredError({
      id: "m-ambiguous",
      status: "QUEUED",
    } as Message))
    leadFindFirstMock.mockResolvedValue({ id: "lead9" })

    const res = await POST(makeReq({ clientId: "c1", message: "hello" }))

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({
      messageId: "m-ambiguous",
      sent: false,
      reconciliationRequired: true,
    })
    expect(crmActivityCreateMock).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ subject: expect.stringMatching(/do not resend/) }),
    }))
  })

  it("returns known provider evidence to the authenticated reconciliation workflow", async () => {
    sendMessageMock.mockRejectedValue(new KnownDispatchPersistenceError({
      message: { id: "m-known", status: "QUEUED" } as Message,
      outcome: "PROVIDER_ACCEPTED",
      providerMessageId: "provider-known",
      firstWriteError: new Error("terminal write unavailable"),
      recoveryWriteError: new Error("recovery write unavailable"),
      holdWriteError: new Error("hold write unavailable"),
    }))

    const res = await POST(makeReq({ clientId: "c1", message: "hello" }))

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({
      messageId: "m-known",
      sent: false,
      reconciliationRequired: true,
      knownDispatchEvidence: {
        outcome: "PROVIDER_ACCEPTED",
        providerMessageId: "provider-known",
      },
    })
  })

  it("an idempotent retry replay remains pending, never sent", async () => {
    sendMessageMock.mockResolvedValue({ id: "m-retrying", status: "RETRYING" })

    const res = await POST(makeReq({ clientId: "c1", message: "hello" }))

    expect(res.status).toBe(202)
    await expect(res.json()).resolves.toMatchObject({ sent: false, pending: true })
  })

  it("a terminal failed reservation is not replayed or presented as sent", async () => {
    sendMessageMock.mockResolvedValue({ id: "m-failed", status: "FAILED_PERMANENT" })

    const res = await POST(makeReq({ clientId: "c1", message: "hello" }))

    expect(res.status).toBe(409)
    await expect(res.json()).resolves.toMatchObject({
      ok: false,
      messageId: "m-failed",
      error: expect.stringContaining("FAILED_PERMANENT"),
    })
  })

  // WA_ENABLED=false (lib/whatsapp.ts) is an eligibility-class condition,
  // not a genuine dispatch failure — retrying can't fix it, same as a
  // consent block. Must read 422 like SendBlockedError above, not 500.
  it("WhatsApp channel disabled: surfaces as 422 like an eligibility block, not 500", async () => {
    sendMessageMock.mockRejectedValue(new Error("WhatsApp disabled"))

    const res = await POST(makeReq({ clientId: "c1", message: "hello" }))
    const json = await res.json() as { error: string }

    expect(res.status).toBe(422)
    expect(json.error).toBe("WhatsApp disabled")
  })

  it("no Contact on file: 404, does not call sendMessage", async () => {
    contactFindFirstMock.mockResolvedValue(null)

    const res = await POST(makeReq({ clientId: "c1", message: "hello" }))

    expect(res.status).toBe(404)
    expect(sendMessageMock).not.toHaveBeenCalled()
  })

  it("Contact has no WhatsApp/phone identity: 422, does not call sendMessage", async () => {
    contactFindFirstMock.mockResolvedValue({ id: "ct1", primaryWaJid: null, primaryPhone: null })

    const res = await POST(makeReq({ clientId: "c1", message: "hello" }))

    expect(res.status).toBe(422)
    expect(sendMessageMock).not.toHaveBeenCalled()
  })

  it("missing message and no clientId/leadId: 422 validation error", async () => {
    const res = await POST(makeReq({ message: "" }))
    expect(res.status).toBe(422)
    expect(contactFindFirstMock).not.toHaveBeenCalled()
  })

  it("missing operationId: 400 before any Contact lookup", async () => {
    const res = await POST(makeReq({ clientId: "c1", message: "hello", operationId: undefined }))
    expect(res.status).toBe(400)
    expect(contactFindFirstMock).not.toHaveBeenCalled()
  })
})
