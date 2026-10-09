/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const requireCommsAgentMock = vi.fn()
const listConversationsMock = vi.fn()

vi.mock("@/lib/inbox/authz", () => ({ requireCommsAgent: () => requireCommsAgentMock() }))
vi.mock("@/lib/tenant", () => ({
  withTenantContext: (req: unknown, cb: (t: { id: string; name: string }) => Promise<unknown>) => cb({ id: "t1", name: "T" }),
}))
vi.mock("@/lib/inbox/conversations", () => ({ listConversations: (a: unknown) => listConversationsMock(a) }))

import { GET } from "./route"

beforeEach(() => {
  vi.clearAllMocks()
  requireCommsAgentMock.mockResolvedValue({ user: { id: "u1", email: "a@b.c", role: "COLLECTIONS_AGENT" } })
  listConversationsMock.mockResolvedValue({ conversations: [], nextCursor: null })
})

it("403 propagates from the guard", async () => {
  const { NextResponse } = await import("next/server")
  requireCommsAgentMock.mockResolvedValue({ error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) })
  const res = await GET(new NextRequest("http://x/api/inbox/conversations"))
  expect(res.status).toBe(403)
  expect(listConversationsMock).not.toHaveBeenCalled()
})

it("passes queue + agent id to listConversations", async () => {
  const res = await GET(new NextRequest("http://x/api/inbox/conversations?queue=mine&limit=10"))
  expect(res.status).toBe(200)
  expect(listConversationsMock).toHaveBeenCalledWith({ tenantId: "t1", queue: "mine", agentUserId: "u1", limit: 10, cursor: undefined })
})

it("defaults an invalid queue to unassigned", async () => {
  await GET(new NextRequest("http://x/api/inbox/conversations?queue=bogus"))
  expect(listConversationsMock).toHaveBeenCalledWith(expect.objectContaining({ queue: "unassigned" }))
})

it("clamps an over-limit request to 100", async () => {
  await GET(new NextRequest("http://x/api/inbox/conversations?limit=500"))
  expect(listConversationsMock).toHaveBeenCalledWith(expect.objectContaining({ limit: 100 }))
})

it("clamps limit=0 to 1", async () => {
  await GET(new NextRequest("http://x/api/inbox/conversations?limit=0"))
  expect(listConversationsMock).toHaveBeenCalledWith(expect.objectContaining({ limit: 1 }))
})
