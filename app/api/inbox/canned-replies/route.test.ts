/* eslint-disable @typescript-eslint/no-explicit-any */
import { it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const requireCommsAgentMock = vi.fn()
const requireApiRoleMock = vi.fn()
const listMock = vi.fn()
const createMock = vi.fn()
vi.mock("@/lib/inbox/authz", () => ({ requireCommsAgent: () => requireCommsAgentMock() }))
vi.mock("@/lib/auth-guards", () => ({ requireApiRole: () => requireApiRoleMock() }))
vi.mock("@/lib/tenant", () => ({ withTenantContext: (req: unknown, cb: (t: any) => Promise<unknown>) => cb({ id: "t1", name: "T" }) }))
vi.mock("@/lib/inbox/canned-replies", () => ({
  listCannedReplies: (t: unknown) => listMock(t),
  createCannedReply: (a: unknown) => createMock(a),
}))

import { GET, POST } from "./route"
const postReq = (body: unknown) => new NextRequest("http://x/api/inbox/canned-replies", { method: "POST", body: JSON.stringify(body) })

beforeEach(() => {
  vi.clearAllMocks()
  requireCommsAgentMock.mockResolvedValue({ user: { id: "u1", email: "a@b.c", role: "ADMIN" } })
  requireApiRoleMock.mockResolvedValue({ user: { id: "admin1", email: "ad@b.c", role: "ADMIN" } })
})

it("GET lists canned replies", async () => {
  listMock.mockResolvedValue([{ id: "cr1", title: "Hi" }])
  const res = await GET(new NextRequest("http://x/api/inbox/canned-replies"))
  expect(res.status).toBe(200)
  expect(listMock).toHaveBeenCalledWith("t1")
})

it("POST creates a canned reply", async () => {
  createMock.mockResolvedValue({ id: "cr1", title: "Hi", body: "Hello there" })
  const res = await POST(postReq({ title: "Hi", body: "Hello there" }))
  expect(res.status).toBe(200)
  expect(createMock).toHaveBeenCalledWith({ tenantId: "t1", title: "Hi", body: "Hello there", createdById: "admin1", actorEmail: "ad@b.c" })
})

it("POST 400 on empty title", async () => {
  const res = await POST(postReq({ title: "  ", body: "Hello there" }))
  expect(res.status).toBe(400)
  expect(createMock).not.toHaveBeenCalled()
})

it("POST 400 on empty body", async () => {
  const res = await POST(postReq({ title: "Hi", body: "" }))
  expect(res.status).toBe(400)
  expect(createMock).not.toHaveBeenCalled()
})

it("GET short-circuits on guard failure without calling listCannedReplies", async () => {
  const { NextResponse } = await import("next/server")
  requireCommsAgentMock.mockResolvedValue({ error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) })
  const res = await GET(new NextRequest("http://x/api/inbox/canned-replies"))
  expect(res.status).toBe(403)
  expect(listMock).not.toHaveBeenCalled()
})

it("POST short-circuits on guard failure without calling createCannedReply", async () => {
  const { NextResponse } = await import("next/server")
  requireApiRoleMock.mockResolvedValue({ error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) })
  const res = await POST(postReq({ title: "Hi", body: "Hello there" }))
  expect(res.status).toBe(403)
  expect(createMock).not.toHaveBeenCalled()
})
