import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"
import { Prisma } from "@prisma/client"

const tenantFindUnique = vi.fn()
const transactionMock = vi.fn()
const contactLookupMock = vi.fn()
const verifyMock = vi.fn()
const writeFailureMock = vi.fn()
const handleWaStopMock = vi.fn()
const logAuditMock = vi.fn()
const getCommsSettingsMock = vi.fn()

vi.mock("@/lib/prisma", () => ({
  prisma: {
    tenant: { findUnique: (args: unknown) => tenantFindUnique(args) },
    $transaction: (cb: unknown) => transactionMock(cb),
  },
}))
vi.mock("@/lib/contact/identity", async (orig) => {
  const real = (await orig()) as Record<string, unknown>
  return {
    ...real,
    lookupContactByChannelValue: (...args: unknown[]) => contactLookupMock(...args),
  }
})
vi.mock("@/lib/webhooks", () => ({
  verifyWaUnofficial: (...args: unknown[]) => verifyMock(...args),
  writeWebhookSignatureFailure: (...args: unknown[]) => writeFailureMock(...args),
}))
vi.mock("@/lib/messaging/wa-stop", () => ({
  handleWaStopInbound: (...args: unknown[]) => handleWaStopMock(...args),
  STOP_REGEX: /^STOP\b/i,
}))
vi.mock("@/lib/audit", () => ({
  logAudit: (...args: unknown[]) => logAuditMock(...args),
}))
vi.mock("@/lib/inbox/settings", () => ({
  getCommsSettings: (...args: unknown[]) => getCommsSettingsMock(...args),
}))
vi.mock("@/lib/inbox/routing", () => ({
  routeInbound: vi.fn(),
}))

import { POST } from "./route"
import { routeInbound } from "@/lib/inbox/routing"

function buildReq(body: object, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("https://staging.acme-lending.example/api/webhooks/whatsapp", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  })
}

const validWabaShape = {
  entry: [{
    changes: [{
      value: {
        messages: [{ id: "wamid.HBgL_x", from: "27821234567", type: "text", text: { body: "STOP" } }],
      },
    }],
  }],
}

describe("POST /api/webhooks/whatsapp", () => {
  beforeEach(() => {
    vi.resetAllMocks()
    process.env.WA_UNOFFICIAL_WEBHOOK_SECRET = "test-secret"
    process.env.NEXT_PUBLIC_TENANT_SLUG = "acme"
    tenantFindUnique.mockResolvedValue({ id: "tenant_acme", slug: "acme" })
    verifyMock.mockReturnValue({ ok: true })
    transactionMock.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => cb({}))
    contactLookupMock.mockResolvedValue({ id: "ct_known", tenantId: "tenant_acme" })
    handleWaStopMock.mockResolvedValue({ messageId: "msg_1", consentRevokedId: "csn_1", conversationId: "cnv_1" })
    // Default: WhatsApp opt-in channel is off by schema default. routeInbound's
    // `!waEnabled` guard then bails immediately for unknown senders, preserving
    // pre-inbox-wiring "unknown sender -> no persist" behaviour.
    getCommsSettingsMock.mockResolvedValue({ whatsappEnabled: false })
    vi.mocked(routeInbound).mockResolvedValue({ handled: false, persisted: false })
  })

  it("STOP from known contact: 200 + handler called + revoke audit + message-received audit", async () => {
    const res = await POST(buildReq(validWabaShape, { "x-wa-signature": "abc" }))
    expect(res.status).toBe(200)
    expect(handleWaStopMock).toHaveBeenCalledTimes(1)
    // This route IS the bridge: flipping PROVIDER must fail here, not ship.
    expect(handleWaStopMock.mock.calls[0][1]).toMatchObject({ provider: "WA_UNOFFICIAL" })
    expect(logAuditMock).toHaveBeenCalledTimes(2)
    const actions = logAuditMock.mock.calls.map(c => c[0].action)
    expect(actions).toContain("CONSENT_REVOKED_VIA_STOP_KEYWORD")
    expect(actions).toContain("MESSAGE_RECEIVED")
  })

  it("STOP from UNKNOWN contact: 200 + no STOP handler call + no persisted write", async () => {
    contactLookupMock.mockResolvedValue(null)
    const res = await POST(buildReq(validWabaShape, { "x-wa-signature": "abc" }))
    expect(res.status).toBe(200)
    expect(handleWaStopMock).not.toHaveBeenCalled()
    expect(logAuditMock).not.toHaveBeenCalled()
  })

  it("unknown sender with whatsappEnabled=true and non-STOP body is captured into the inbox", async () => {
    contactLookupMock.mockResolvedValue(null)
    getCommsSettingsMock.mockResolvedValue({ whatsappEnabled: true })
    vi.mocked(routeInbound).mockResolvedValue({
      handled: true,
      persisted: true,
      conversationId: "cv-new",
      messageId: "m-new",
      contactId: "ct-new",
    })
    const captured = structuredClone(validWabaShape)
    captured.entry[0].changes[0].value.messages[0].text.body = "Hi, is my loan approved?"

    const res = await POST(buildReq(captured, { "x-wa-signature": "abc" }))
    const body = await res.json()

    expect(routeInbound).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        waEnabled: true,
        isStop: false,
        fromValue: "27821234567@s.whatsapp.net",
        fromPhone: "27821234567",
        text: "Hi, is my loan approved?",
        providerMessageId: "wamid.HBgL_x",
        provider: "WA_UNOFFICIAL",
      }),
    )
    expect(res.status).toBe(200)
    expect(body).toMatchObject({ ok: true, persisted: true, messageId: "m-new" })
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "MESSAGE_RECEIVED",
        entityId: "m-new",
        newValue: expect.objectContaining({ provider: "WA_UNOFFICIAL" }),
      }),
    )
  })

  it("redelivered wamid (at-least-once BSP retry): second delivery of the same payload returns 200, no reply queued, no duplicate audit events", async () => {
    const dupPayload = structuredClone(validWabaShape)

    // First delivery persists normally.
    const first = await POST(buildReq(dupPayload, { "x-wa-signature": "abc" }))
    expect(first.status).toBe(200)
    expect(logAuditMock).toHaveBeenCalledTimes(2)

    logAuditMock.mockClear()

    // Redelivery of the same wamid re-hits the Message
    // @@unique([provider, providerMessageId]) constraint; the transaction
    // rolls back and Prisma surfaces P2002.
    transactionMock.mockImplementationOnce(async () => {
      throw new Prisma.PrismaClientKnownRequestError(
        "Unique constraint failed on the fields: (`provider`,`providerMessageId`)",
        { code: "P2002", clientVersion: "5.0.0", meta: { target: ["provider", "providerMessageId"] } },
      )
    })

    const second = await POST(buildReq(dupPayload, { "x-wa-signature": "abc" }))
    const body = await second.json()
    expect(second.status).toBe(200)
    expect(body).toMatchObject({ ok: true, persisted: false, duplicate: true })
    expect(logAuditMock).not.toHaveBeenCalled()
  })

  it("P2002 on an unrelated constraint is not swallowed as a duplicate", async () => {
    transactionMock.mockImplementationOnce(async () => {
      throw new Prisma.PrismaClientKnownRequestError(
        "Unique constraint failed on the fields: (`tenantId`,`fromValue`)",
        { code: "P2002", clientVersion: "5.0.0", meta: { target: ["tenantId", "fromValue"] } },
      )
    })
    await expect(POST(buildReq(validWabaShape, { "x-wa-signature": "abc" }))).rejects.toThrow()
  })

  it("non-STOP body from known contact: handler called, no CONSENT audit emitted", async () => {
    handleWaStopMock.mockResolvedValue({ messageId: "msg_2", consentRevokedId: null, conversationId: "cnv_1" })
    const nonStop = structuredClone(validWabaShape)
    nonStop.entry[0].changes[0].value.messages[0].text.body = "what is my balance?"
    const res = await POST(buildReq(nonStop, { "x-wa-signature": "abc" }))
    expect(res.status).toBe(200)
    expect(handleWaStopMock).toHaveBeenCalledTimes(1)
    expect(handleWaStopMock.mock.calls[0][1]).toMatchObject({ provider: "WA_UNOFFICIAL" })
    const actions = logAuditMock.mock.calls.map(c => c[0].action)
    expect(actions).not.toContain("CONSENT_REVOKED_VIA_STOP_KEYWORD")
    expect(actions).toContain("MESSAGE_RECEIVED")
  })

  it("bad signature: 401 + WebhookSignatureFailure + no handler call", async () => {
    verifyMock.mockReturnValue({ ok: false, reason: "BAD_HMAC" })
    const res = await POST(buildReq(validWabaShape, { "x-wa-signature": "wrong" }))
    expect(res.status).toBe(401)
    expect(writeFailureMock).toHaveBeenCalledTimes(1)
    expect(writeFailureMock.mock.calls[0][0]).toMatchObject({
      provider: "WA_UNOFFICIAL",
      reason: "BAD_HMAC",
    })
    expect(handleWaStopMock).not.toHaveBeenCalled()
  })

  it("missing signature header (MISSING_HEADER): 401 + failure row with MISSING_HEADER reason", async () => {
    verifyMock.mockReturnValue({ ok: false, reason: "MISSING_HEADER" })
    const res = await POST(buildReq(validWabaShape, {}))
    expect(res.status).toBe(401)
    expect(writeFailureMock).toHaveBeenCalledTimes(1)
    expect(writeFailureMock.mock.calls[0][0]).toMatchObject({
      provider: "WA_UNOFFICIAL",
      reason: "MISSING_HEADER",
    })
    expect(handleWaStopMock).not.toHaveBeenCalled()
  })

  it("missing WA_UNOFFICIAL_WEBHOOK_SECRET: 500", async () => {
    delete process.env.WA_UNOFFICIAL_WEBHOOK_SECRET
    const res = await POST(buildReq(validWabaShape, { "x-wa-signature": "abc" }))
    expect(res.status).toBe(500)
  })

  it("missing NEXT_PUBLIC_TENANT_SLUG: 500", async () => {
    delete process.env.NEXT_PUBLIC_TENANT_SLUG
    const res = await POST(buildReq(validWabaShape, { "x-wa-signature": "abc" }))
    expect(res.status).toBe(500)
    expect(handleWaStopMock).not.toHaveBeenCalled()
  })

  it("tenant slug does not resolve to a row: 500", async () => {
    tenantFindUnique.mockResolvedValue(null)
    const res = await POST(buildReq(validWabaShape, { "x-wa-signature": "abc" }))
    expect(res.status).toBe(500)
    expect(handleWaStopMock).not.toHaveBeenCalled()
    expect(verifyMock).not.toHaveBeenCalled()
  })

  it("malformed JSON body: 400 + no DB writes", async () => {
    const malformed = new NextRequest("https://staging.acme-lending.example/api/webhooks/whatsapp", {
      method: "POST",
      headers: { "x-wa-signature": "abc" },
      body: "not json",
    })
    const res = await POST(malformed)
    expect(res.status).toBe(400)
    expect(handleWaStopMock).not.toHaveBeenCalled()
  })

  it("WABA payload missing entry[0].changes[0].value.messages[0]: 400", async () => {
    const res = await POST(buildReq({ entry: [] }, { "x-wa-signature": "abc" }))
    expect(res.status).toBe(400)
    expect(handleWaStopMock).not.toHaveBeenCalled()
  })
})
