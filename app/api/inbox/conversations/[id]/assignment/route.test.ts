/* eslint-disable @typescript-eslint/no-explicit-any */
import { it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const requireCommsAgentMock = vi.fn()
const claimMock = vi.fn()
const releaseMock = vi.fn()
const reassignMock = vi.fn()
const joinChatMock = vi.fn()
const leaveChatMock = vi.fn()
const findFirstMock = vi.fn()
vi.mock("@/lib/inbox/authz", () => ({ requireCommsAgent: () => requireCommsAgentMock() }))
vi.mock("@/lib/tenant", () => ({ withTenantContext: (req: unknown, cb: (t: any) => Promise<unknown>) => cb({ id: "t1", name: "T" }) }))
vi.mock("@/lib/inbox/assignment", () => ({
  claimConversation: (a: unknown) => claimMock(a),
  releaseConversation: (a: unknown) => releaseMock(a),
  reassignConversation: (a: unknown) => reassignMock(a),
}))
vi.mock("@/lib/website-chat/staff", () => ({ joinChat: (a: unknown) => joinChatMock(a), leaveChat: (a: unknown) => leaveChatMock(a) }))
vi.mock("@/lib/prisma", () => ({ prisma: { conversation: { findFirst: (a: unknown) => findFirstMock(a) } } }))

import { POST } from "./route"
const ctx = { params: Promise.resolve({ id: "cv1" }) }
const req = (body: unknown) => new NextRequest("http://x/api/inbox/conversations/cv1/assignment", { method: "POST", body: JSON.stringify(body) })

beforeEach(() => {
  vi.clearAllMocks()
  requireCommsAgentMock.mockResolvedValue({ user: { id: "u1", email: "a@b.c", role: "COLLECTIONS_AGENT" } })
  findFirstMock.mockResolvedValue({ channel: "WHATSAPP" })
})

it("claim → claimConversation with the caller id", async () => {
  claimMock.mockResolvedValue({ ok: true })
  const res = await POST(req({ action: "claim" }), ctx)
  expect(res.status).toBe(200)
  expect(claimMock).toHaveBeenCalledWith({ tenantId: "t1", conversationId: "cv1", agentUserId: "u1", agentEmail: "a@b.c" })
})

it("claim conflict → 409 with reason", async () => {
  claimMock.mockResolvedValue({ ok: false, reason: "ALREADY_CLAIMED" })
  const res = await POST(req({ action: "claim" }), ctx)
  expect(res.status).toBe(409)
  expect(await res.json()).toEqual({ ok: false, reason: "ALREADY_CLAIMED" })
})

it("claim on a website chat → joinChat, not the generic claim", async () => {
  findFirstMock.mockResolvedValue({ channel: "CHATBOT" })
  joinChatMock.mockResolvedValue({ ok: true })
  const res = await POST(req({ action: "claim" }), ctx)
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ ok: true })
  expect(findFirstMock).toHaveBeenCalledWith({ where: { id: "cv1", tenantId: "t1" }, select: { channel: true } })
  expect(joinChatMock).toHaveBeenCalledWith({ tenantId: "t1", conversationId: "cv1", staffUserId: "u1", staffEmail: "a@b.c", now: expect.any(Date) })
  expect(claimMock).not.toHaveBeenCalled()
})

it.each(["ALREADY_CLAIMED", "NOT_FOUND"])("website chat join refused (%s) → 409 with reason, like the generic claim", async (reason) => {
  findFirstMock.mockResolvedValue({ channel: "CHATBOT" })
  joinChatMock.mockResolvedValue({ ok: false, reason })
  const res = await POST(req({ action: "claim" }), ctx)
  expect(res.status).toBe(409)
  expect(await res.json()).toEqual({ ok: false, reason })
  expect(claimMock).not.toHaveBeenCalled()
})

it("claim on any other channel, or on a thread that does not exist, stays the generic claim", async () => {
  claimMock.mockResolvedValue({ ok: false, reason: "ALREADY_CLAIMED" })
  for (const found of [{ channel: "WHATSAPP" }, { channel: "EMAIL" }, null]) {
    findFirstMock.mockResolvedValue(found)
    expect((await POST(req({ action: "claim" }), ctx)).status).toBe(409)
  }
  expect(claimMock).toHaveBeenCalledTimes(3)
  expect(joinChatMock).not.toHaveBeenCalled()
})

it("release on a website chat → leaveChat, not the generic release", async () => {
  findFirstMock.mockResolvedValue({ channel: "CHATBOT" })
  leaveChatMock.mockResolvedValue({ ok: true })
  expect((await POST(req({ action: "release" }), ctx)).status).toBe(200)
  expect(leaveChatMock).toHaveBeenCalledWith({ tenantId: "t1", conversationId: "cv1", staffUserId: "u1", staffEmail: "a@b.c", asAdmin: false, now: expect.any(Date) })
  expect(releaseMock).not.toHaveBeenCalled()

  leaveChatMock.mockResolvedValue({ ok: false, reason: "NOT_ASSIGNED_TO_YOU" })
  const res = await POST(req({ action: "release" }), ctx)
  expect(res.status).toBe(409)
  expect(await res.json()).toEqual({ ok: false, reason: "NOT_ASSIGNED_TO_YOU" })
})

it("reassign on a website chat is refused and nothing is called", async () => {
  findFirstMock.mockResolvedValue({ channel: "CHATBOT" })
  const res = await POST(req({ action: "reassign", assigneeId: "u2" }), ctx)
  expect(res.status).toBe(409)
  expect(await res.json()).toEqual({ error: "Website chats can't be reassigned. Release the chat and let a colleague join it." })
  for (const m of [reassignMock, releaseMock, claimMock, joinChatMock, leaveChatMock]) expect(m).not.toHaveBeenCalled()
})

it("release on any other channel stays the generic release", async () => {
  releaseMock.mockResolvedValue({ ok: true })
  expect((await POST(req({ action: "release" }), ctx)).status).toBe(200)
  expect(releaseMock).toHaveBeenCalledWith({ tenantId: "t1", conversationId: "cv1", agentUserId: "u1", agentEmail: "a@b.c" })
  expect(leaveChatMock).not.toHaveBeenCalled()
})

it("reassign requires assigneeId", async () => {
  const res = await POST(req({ action: "reassign" }), ctx)
  expect(res.status).toBe(400)
  expect(reassignMock).not.toHaveBeenCalled()
})

it("reassign → reassignConversation", async () => {
  reassignMock.mockResolvedValue({ ok: true })
  const res = await POST(req({ action: "reassign", assigneeId: "u2" }), ctx)
  expect(res.status).toBe(200)
  expect(reassignMock).toHaveBeenCalledWith({ tenantId: "t1", conversationId: "cv1", newAssigneeId: "u2", actorUserId: "u1", actorEmail: "a@b.c" })
})

it("unknown action → 400", async () => {
  const res = await POST(req({ action: "delete" }), ctx)
  expect(res.status).toBe(400)
})

it("short-circuits on guard failure without calling any assignment fn", async () => {
  const { NextResponse } = await import("next/server")
  requireCommsAgentMock.mockResolvedValue({ error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) })
  const res = await POST(req({ action: "claim" }), ctx)
  expect(res.status).toBe(403)
  expect(claimMock).not.toHaveBeenCalled()
  expect(releaseMock).not.toHaveBeenCalled()
  expect(reassignMock).not.toHaveBeenCalled()
})

it.each([
  ["BRANCH_MANAGER", false],
  ["ADMIN", true],
  ["SUPER_ADMIN", true],
])("release on a website chat by a %s may release a colleague's chat: %s", async (role, asAdmin) => {
  requireCommsAgentMock.mockResolvedValue({ user: { id: "u1", email: "a@b.c", role } })
  findFirstMock.mockResolvedValue({ channel: "CHATBOT" })
  leaveChatMock.mockResolvedValue({ ok: true })
  await POST(req({ action: "release" }), ctx)
  expect(leaveChatMock).toHaveBeenCalledWith(expect.objectContaining({ staffUserId: "u1", asAdmin }))
})
