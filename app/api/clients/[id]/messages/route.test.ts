import { it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const requireApiRoleMock = vi.fn()
const withTenantContextMock = vi.fn()
const clientFindFirstMock = vi.fn()
const sendAgentMessageMock = vi.fn()

vi.mock("@/lib/auth-guards", () => ({ requireApiRole: () => requireApiRoleMock() }))
vi.mock("@/lib/tenant", () => ({
  withTenantContext: (req: unknown, cb: (t: { id: string; name: string }) => Promise<unknown>) =>
    withTenantContextMock(req, cb),
}))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    client: {
      findFirst: (a: unknown) => clientFindFirstMock(a),
    },
  },
}))
vi.mock("@/lib/messaging/agent-message", () => ({
  sendAgentMessage: (a: unknown) => sendAgentMessageMock(a),
}))

import { POST } from "./route"

const ctx = { params: Promise.resolve({ id: "c1" }) }
const OPERATION_ID = "11111111-1111-4111-8111-111111111111"
function req(body: Record<string, unknown>) {
  return new NextRequest("http://x/api/clients/c1/messages", {
    method: "POST",
    body: JSON.stringify({ operationId: OPERATION_ID, ...body }),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  requireApiRoleMock.mockResolvedValue({ user: { id: "u1", email: "a@b.c", role: "READONLY" } })
  withTenantContextMock.mockImplementation((_req: unknown, cb: (t: { id: string; name: string }) => Promise<unknown>) =>
    cb({ id: "t1", name: "Acme Lending" }))
})

it("401 when the guard denies — sendAgentMessage not called", async () => {
  const { NextResponse } = await import("next/server")
  requireApiRoleMock.mockResolvedValue({ error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) })
  const res = await POST(req({ channel: "EMAIL", text: "hi" }), ctx)
  expect(res.status).toBe(401)
  expect(sendAgentMessageMock).not.toHaveBeenCalled()
})

it("400 when text is empty", async () => {
  const res = await POST(req({ channel: "EMAIL", text: "   " }), ctx)
  expect(res.status).toBe(400)
  expect(await res.json()).toEqual({ error: "text is required" })
  expect(sendAgentMessageMock).not.toHaveBeenCalled()
})

it("400 when channel is invalid", async () => {
  const res = await POST(req({ channel: "CARRIER_PIGEON", text: "hi" }), ctx)
  expect(res.status).toBe(400)
  expect(await res.json()).toEqual({ error: "invalid channel" })
  expect(sendAgentMessageMock).not.toHaveBeenCalled()
})

it("400 when channel is missing", async () => {
  const res = await POST(req({ text: "hi" }), ctx)
  expect(res.status).toBe(400)
  expect(await res.json()).toEqual({ error: "invalid channel" })
  expect(sendAgentMessageMock).not.toHaveBeenCalled()
})

it("400 when operationId is missing", async () => {
  const res = await POST(req({ channel: "EMAIL", text: "hi", operationId: undefined }), ctx)
  expect(res.status).toBe(400)
  expect(await res.json()).toEqual({ error: "operationId is required" })
})

it("400 when the client has no contact", async () => {
  clientFindFirstMock.mockResolvedValue({ id: "c1", contact: null })
  const res = await POST(req({ channel: "EMAIL", text: "hi" }), ctx)
  expect(res.status).toBe(400)
  expect(await res.json()).toEqual({ error: "client has no contact" })
  expect(sendAgentMessageMock).not.toHaveBeenCalled()
})

it("400 when the client does not exist", async () => {
  clientFindFirstMock.mockResolvedValue(null)
  const res = await POST(req({ channel: "EMAIL", text: "hi" }), ctx)
  expect(res.status).toBe(400)
  expect(await res.json()).toEqual({ error: "client has no contact" })
  expect(sendAgentMessageMock).not.toHaveBeenCalled()
})

it("200 passthrough of {messageId, conversationId} on success", async () => {
  clientFindFirstMock.mockResolvedValue({ id: "c1", contact: { id: "ct1" } })
  sendAgentMessageMock.mockResolvedValue({ ok: true, messageId: "m1", conversationId: "cv1", status: "SENT", outcome: "sent" })
  const res = await POST(req({ channel: "EMAIL", text: "hello", subject: "Hi", loanId: "L1" }), ctx)
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ messageId: "m1", conversationId: "cv1", status: "SENT", outcome: "sent", reconciliationRequired: false })
  expect(clientFindFirstMock).toHaveBeenCalledWith({
    where: { id: "c1", tenantId: "t1" },
    include: { contact: true },
  })
  expect(sendAgentMessageMock).toHaveBeenCalledWith({
    tenantId: "t1",
    contactId: "ct1",
    channel: "EMAIL",
    text: "hello",
    subject: "Hi",
    attachments: undefined,
    agentUserId: "u1",
    loanId: "L1",
    operationId: OPERATION_ID,
  })
})

it("decodes base64 attachments to a Buffer before calling sendAgentMessage", async () => {
  clientFindFirstMock.mockResolvedValue({ id: "c1", contact: { id: "ct1" } })
  sendAgentMessageMock.mockResolvedValue({ ok: true, messageId: "m1", conversationId: "cv1", status: "SENT", outcome: "sent" })
  const contentBase64 = Buffer.from("hello world").toString("base64")
  const res = await POST(
    req({
      channel: "EMAIL",
      text: "hello",
      subject: "Hi",
      attachments: [{ filename: "a.pdf", contentType: "application/pdf", contentBase64 }],
    }),
    ctx,
  )
  expect(res.status).toBe(200)
  expect(sendAgentMessageMock).toHaveBeenCalledWith(
    expect.objectContaining({
      attachments: [{ filename: "a.pdf", contentType: "application/pdf", content: Buffer.from("hello world") }],
    }),
  )
  const call = sendAgentMessageMock.mock.calls[0][0] as { attachments: Array<{ content: Buffer }> }
  expect(Buffer.isBuffer(call.attachments[0].content)).toBe(true)
})

it("400 when attachment count exceeds 5", async () => {
  const contentBase64 = Buffer.from("x").toString("base64")
  const attachments = Array.from({ length: 6 }, (_, i) => ({
    filename: `f${i}.pdf`,
    contentType: "application/pdf",
    contentBase64,
  }))
  const res = await POST(req({ channel: "EMAIL", text: "hi", attachments }), ctx)
  expect(res.status).toBe(400)
  expect(await res.json()).toEqual({ error: "attachments too large" })
  expect(sendAgentMessageMock).not.toHaveBeenCalled()
})

it("400 when total attachment size exceeds 10 MB", async () => {
  const big = Buffer.alloc(11 * 1024 * 1024, "a").toString("base64")
  const res = await POST(
    req({ channel: "EMAIL", text: "hi", attachments: [{ filename: "big.pdf", contentType: "application/pdf", contentBase64: big }] }),
    ctx,
  )
  expect(res.status).toBe(400)
  expect(await res.json()).toEqual({ error: "attachments too large" })
  expect(sendAgentMessageMock).not.toHaveBeenCalled()
})

it("409 {reason, detail} when sendAgentMessage returns ok:false", async () => {
  clientFindFirstMock.mockResolvedValue({ id: "c1", contact: { id: "ct1" } })
  sendAgentMessageMock.mockResolvedValue({ ok: false, reason: "NO_DESTINATION", detail: "contact not found" })
  const res = await POST(req({ channel: "WHATSAPP", text: "hi" }), ctx)
  expect(res.status).toBe(409)
  expect(await res.json()).toEqual({ reason: "NO_DESTINATION", detail: "contact not found" })
})
