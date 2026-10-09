/* eslint-disable @typescript-eslint/no-explicit-any */
import { it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const requireCommsAgentMock = vi.fn()
const getThreadMock = vi.fn()
const markReadMock = vi.fn()
const setStatusMock = vi.fn()
const setPriorityMock = vi.fn()

vi.mock("@/lib/inbox/authz", () => ({ requireCommsAgent: () => requireCommsAgentMock() }))
vi.mock("@/lib/tenant", () => ({ withTenantContext: (req: unknown, cb: (t: any) => Promise<unknown>) => cb({ id: "t1", name: "T" }) }))
vi.mock("@/lib/inbox/conversations", () => ({ getThread: (a: unknown) => getThreadMock(a) }))
vi.mock("@/lib/inbox/thread-actions", () => ({
  markConversationRead: (a: unknown) => markReadMock(a),
  setConversationStatus: (a: unknown) => setStatusMock(a),
  setConversationPriority: (a: unknown) => setPriorityMock(a),
}))

import { GET, PATCH } from "./route"
const ctx = { params: Promise.resolve({ id: "cv1" }) }

beforeEach(() => {
  vi.clearAllMocks()
  requireCommsAgentMock.mockResolvedValue({ user: { id: "u1", email: "a@b.c", role: "ADMIN" } })
})

it("GET marks read then returns the thread", async () => {
  getThreadMock.mockResolvedValue({ conversation: { id: "cv1", channel: "WHATSAPP" }, messages: [] })
  markReadMock.mockResolvedValue({ marked: 1 })
  const res = await GET(new NextRequest("http://x/api/inbox/conversations/cv1"), ctx)
  expect(res.status).toBe(200)
  expect(markReadMock).toHaveBeenCalledWith({ tenantId: "t1", conversationId: "cv1" })
  expect(getThreadMock).toHaveBeenCalledWith({ tenantId: "t1", conversationId: "cv1" })
})

it("GET 404 when the thread is not in the tenant", async () => {
  getThreadMock.mockResolvedValue(null)
  markReadMock.mockResolvedValue({ marked: 0 })
  const res = await GET(new NextRequest("http://x/api/inbox/conversations/cvX"), ctx)
  expect(res.status).toBe(404)
})

it("PATCH applies a valid status", async () => {
  setStatusMock.mockResolvedValue({ ok: true })
  const res = await PATCH(new NextRequest("http://x/api/inbox/conversations/cv1", { method: "PATCH", body: JSON.stringify({ status: "CLOSED" }) }), ctx)
  expect(res.status).toBe(200)
  expect(setStatusMock).toHaveBeenCalledWith(expect.objectContaining({ tenantId: "t1", conversationId: "cv1", status: "CLOSED", actorUserId: "u1" }))
})

it("PATCH rejects an invalid priority with 400", async () => {
  const res = await PATCH(new NextRequest("http://x/api/inbox/conversations/cv1", { method: "PATCH", body: JSON.stringify({ priority: "SUPER" }) }), ctx)
  expect(res.status).toBe(400)
  expect(setPriorityMock).not.toHaveBeenCalled()
})

it("PATCH 404s when the status update matches no row", async () => {
  setStatusMock.mockResolvedValue({ ok: false, reason: "NOT_FOUND" })
  const res = await PATCH(new NextRequest("http://x/api/inbox/conversations/cvX", { method: "PATCH", body: JSON.stringify({ status: "CLOSED" }) }), ctx)
  expect(res.status).toBe(404)
})

it("PATCH 409s with the open thread's id when reopening would make a second open thread", async () => {
  setStatusMock.mockResolvedValue({ ok: false, reason: "ANOTHER_THREAD_OPEN", openConversationId: "cv-open" })
  const res = await PATCH(new NextRequest("http://x/api/inbox/conversations/cv1", { method: "PATCH", body: JSON.stringify({ status: "OPEN" }) }), ctx)
  expect(res.status).toBe(409)
  expect(await res.json()).toEqual({
    error: "This contact already has an open thread — open that one instead.",
    openConversationId: "cv-open",
  })
})

it("GET short-circuits with the guard's response when unauthorized", async () => {
  const { NextResponse } = await import("next/server")
  requireCommsAgentMock.mockResolvedValue({ error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) })
  const res = await GET(new NextRequest("http://x/api/inbox/conversations/cv1"), ctx)
  expect(res.status).toBe(403)
  expect(markReadMock).not.toHaveBeenCalled()
  expect(getThreadMock).not.toHaveBeenCalled()
})

it("PATCH short-circuits with the guard's response when unauthorized", async () => {
  const { NextResponse } = await import("next/server")
  requireCommsAgentMock.mockResolvedValue({ error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) })
  const res = await PATCH(new NextRequest("http://x/api/inbox/conversations/cv1", { method: "PATCH", body: JSON.stringify({ status: "CLOSED" }) }), ctx)
  expect(res.status).toBe(403)
  expect(setStatusMock).not.toHaveBeenCalled()
  expect(setPriorityMock).not.toHaveBeenCalled()
})
