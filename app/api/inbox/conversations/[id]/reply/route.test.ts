/* eslint-disable @typescript-eslint/no-explicit-any */
import { it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const requireCommsAgentMock = vi.fn()
const dispatchMock = vi.fn()
vi.mock("@/lib/inbox/authz", () => ({ requireCommsAgent: () => requireCommsAgentMock() }))
vi.mock("@/lib/tenant", () => ({ withTenantContext: (req: unknown, cb: (t: any) => Promise<unknown>) => cb({ id: "t1", name: "T" }) }))
vi.mock("@/lib/inbox/dispatch", () => ({ dispatchAgentReply: (a: unknown) => dispatchMock(a) }))

import { POST } from "./route"
const ctx = { params: Promise.resolve({ id: "cv1" }) }
const OPERATION_ID = "11111111-1111-4111-8111-111111111111"
const req = (body: Record<string, unknown>) => new NextRequest("http://x/api/inbox/conversations/cv1/reply", {
  method: "POST",
  body: JSON.stringify({ operationId: OPERATION_ID, ...body }),
})

beforeEach(() => {
  vi.clearAllMocks()
  requireCommsAgentMock.mockResolvedValue({ user: { id: "u1", email: "a@b.c", role: "COLLECTIONS_AGENT" } })
})

it("400 on empty text", async () => {
  const res = await POST(req({ text: "   " }), ctx)
  expect(res.status).toBe(400)
  expect(dispatchMock).not.toHaveBeenCalled()
})

it("sends via dispatchAgentReply and returns the message", async () => {
  dispatchMock.mockResolvedValue({ ok: true, message: { id: "m1", status: "SENT" }, outcome: "sent" })
  const res = await POST(req({ text: "hello" }), ctx)
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({
    ok: true,
    message: { id: "m1", status: "SENT" },
    outcome: "sent",
    reconciliationRequired: false,
  })
  expect(dispatchMock).toHaveBeenCalledWith({
    tenantId: "t1",
    conversationId: "cv1",
    agentUserId: "u1",
    agentEmail: "a@b.c",
    text: "hello",
    operationId: OPERATION_ID,
  })
})

it("400 when operationId is missing", async () => {
  const res = await POST(req({ text: "hello", operationId: undefined }), ctx)
  expect(res.status).toBe(400)
  expect(dispatchMock).not.toHaveBeenCalled()
})

it("returns 200 ok:false on CHANNEL_DISABLED (fallback CTA)", async () => {
  dispatchMock.mockResolvedValue({ ok: false, reason: "CHANNEL_DISABLED", detail: "WhatsApp channel is disabled." })
  const res = await POST(req({ text: "hi" }), ctx)
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ ok: false, reason: "CHANNEL_DISABLED", detail: "WhatsApp channel is disabled." })
})

it("returns 404 when the conversation is not found", async () => {
  dispatchMock.mockResolvedValue({ ok: false, reason: "CONVERSATION_NOT_FOUND" })
  const res = await POST(req({ text: "hi" }), ctx)
  expect(res.status).toBe(404)
})

it("short-circuits on guard failure without calling dispatchAgentReply", async () => {
  const { NextResponse } = await import("next/server")
  requireCommsAgentMock.mockResolvedValue({ error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) })
  const res = await POST(req({ text: "hi" }), ctx)
  expect(res.status).toBe(403)
  expect(dispatchMock).not.toHaveBeenCalled()
})

it("forwards a valid channel to the dispatcher", async () => {
  dispatchMock.mockResolvedValue({ ok: true, message: { id: "m1" }, outcome: "sent" })
  const res = await POST(req({ text: "hi", channel: "EMAIL" }), ctx)
  expect(res.status).toBe(200)
  expect(dispatchMock.mock.calls[0][0].channel).toBe("EMAIL")
})

it("omits channel when the body has none, letting the server default", async () => {
  dispatchMock.mockResolvedValue({ ok: true, message: { id: "m1" }, outcome: "sent" })
  await POST(req({ text: "hi" }), ctx)
  expect(dispatchMock.mock.calls[0][0].channel).toBeUndefined()
})

it("rejects an unsupported channel with 400", async () => {
  const res = await POST(req({ text: "hi", channel: "SMS" }), ctx)
  expect(res.status).toBe(400)
  expect(await res.json()).toEqual({ error: "channel must be WHATSAPP or EMAIL" })
  expect(dispatchMock).not.toHaveBeenCalled()
})
