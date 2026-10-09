import { it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const requireApiRoleMock = vi.fn()
const withTenantContextMock = vi.fn()
const clientFindFirstMock = vi.fn()
const conversationFindFirstMock = vi.fn()
const dispatchAgentReplyMock = vi.fn()

vi.mock("@/lib/auth-guards", () => ({ requireApiRole: () => requireApiRoleMock() }))
vi.mock("@/lib/tenant", () => ({
  withTenantContext: (req: unknown, cb: (t: { id: string }) => Promise<unknown>) => withTenantContextMock(req, cb),
}))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    client: { findFirst: (a: unknown) => clientFindFirstMock(a) },
    conversation: { findFirst: (a: unknown) => conversationFindFirstMock(a) },
  },
}))
vi.mock("@/lib/inbox/dispatch", () => ({ dispatchAgentReply: (a: unknown) => dispatchAgentReplyMock(a) }))

import { POST } from "./route"

const ctx = { params: Promise.resolve({ id: "c1", conversationId: "cv1" }) }
const OPERATION_ID = "11111111-1111-4111-8111-111111111111"
function req(body: Record<string, unknown>) {
  return new NextRequest("http://x/api/clients/c1/comms/threads/cv1/reply", {
    method: "POST",
    body: JSON.stringify({ operationId: OPERATION_ID, ...body }),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  requireApiRoleMock.mockResolvedValue({ user: { id: "u1", email: "a@b.c", role: "READONLY" } })
  withTenantContextMock.mockImplementation((_req: unknown, cb: (t: { id: string }) => Promise<unknown>) => cb({ id: "t1" }))
  clientFindFirstMock.mockResolvedValue({ id: "c1", contact: { id: "ct1" } })
  conversationFindFirstMock.mockResolvedValue({ id: "cv1" })
})

it("401 when the guard denies — dispatch not called", async () => {
  const { NextResponse } = await import("next/server")
  requireApiRoleMock.mockResolvedValue({ error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) })
  const res = await POST(req({ text: "hi" }), ctx)
  expect(res.status).toBe(401)
  expect(dispatchAgentReplyMock).not.toHaveBeenCalled()
})

it("400 when text is empty", async () => {
  const res = await POST(req({ text: "   " }), ctx)
  expect(res.status).toBe(400)
  expect(dispatchAgentReplyMock).not.toHaveBeenCalled()
})

it("400 when the client has no contact", async () => {
  clientFindFirstMock.mockResolvedValue({ id: "c1", contact: null })
  const res = await POST(req({ text: "hi" }), ctx)
  expect(res.status).toBe(400)
  expect(dispatchAgentReplyMock).not.toHaveBeenCalled()
})

it("404 when the conversation does not belong to the client's contact (ownership)", async () => {
  conversationFindFirstMock.mockResolvedValue(null)
  const res = await POST(req({ text: "hi" }), ctx)
  expect(res.status).toBe(404)
  expect(dispatchAgentReplyMock).not.toHaveBeenCalled()
  // ownership query must be scoped by contactId
  expect(conversationFindFirstMock).toHaveBeenCalledWith({
    where: { id: "cv1", tenantId: "t1", contactId: "ct1" },
    select: { id: true },
  })
})

it("200 {ok:true, message} on a successful dispatch", async () => {
  dispatchAgentReplyMock.mockResolvedValue({ ok: true, message: { id: "m1", status: "SENT" }, outcome: "sent" })
  const res = await POST(req({ text: "hello" }), ctx)
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({
    ok: true,
    message: { id: "m1", status: "SENT" },
    outcome: "sent",
    reconciliationRequired: false,
  })
  expect(dispatchAgentReplyMock).toHaveBeenCalledWith({
    tenantId: "t1",
    conversationId: "cv1",
    agentUserId: "u1",
    text: "hello",
    operationId: OPERATION_ID,
  })
})

it("400 when operationId is missing", async () => {
  const res = await POST(req({ text: "hello", operationId: undefined }), ctx)
  expect(res.status).toBe(400)
  expect(dispatchAgentReplyMock).not.toHaveBeenCalled()
})

it("200 {ok:false, reason, detail} for a soft channel failure (fallback CTA)", async () => {
  dispatchAgentReplyMock.mockResolvedValue({ ok: false, reason: "CHANNEL_DISABLED", detail: "Email is not SMTP-configured." })
  const res = await POST(req({ text: "hello" }), ctx)
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ ok: false, reason: "CHANNEL_DISABLED", detail: "Email is not SMTP-configured." })
})

it("404 when dispatch reports CONVERSATION_NOT_FOUND", async () => {
  dispatchAgentReplyMock.mockResolvedValue({ ok: false, reason: "CONVERSATION_NOT_FOUND" })
  const res = await POST(req({ text: "hello" }), ctx)
  expect(res.status).toBe(404)
})

it("forwards a valid channel to the dispatcher", async () => {
  dispatchAgentReplyMock.mockResolvedValue({ ok: true, message: { id: "m1" }, outcome: "sent" })
  const res = await POST(req({ text: "hi", channel: "EMAIL" }), ctx)
  expect(res.status).toBe(200)
  expect(dispatchAgentReplyMock.mock.calls[0][0].channel).toBe("EMAIL")
})

it("omits channel when the body has none, letting the server default", async () => {
  dispatchAgentReplyMock.mockResolvedValue({ ok: true, message: { id: "m1" }, outcome: "sent" })
  await POST(req({ text: "hi" }), ctx)
  expect(dispatchAgentReplyMock.mock.calls[0][0].channel).toBeUndefined()
})

it("rejects an unsupported channel with 400", async () => {
  const res = await POST(req({ text: "hi", channel: "SMS" }), ctx)
  expect(res.status).toBe(400)
  expect(await res.json()).toEqual({ error: "channel must be WHATSAPP or EMAIL" })
  expect(dispatchAgentReplyMock).not.toHaveBeenCalled()
})
