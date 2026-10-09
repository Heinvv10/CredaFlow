/* eslint-disable @typescript-eslint/no-explicit-any */
import { it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const requireCommsAgentMock = vi.fn()
const getInboxDeltasMock = vi.fn()
vi.mock("@/lib/inbox/authz", () => ({ requireCommsAgent: () => requireCommsAgentMock() }))
vi.mock("@/lib/tenant", () => ({ withTenantContext: (req: unknown, cb: (t: any) => Promise<unknown>) => cb({ id: "t1", name: "T" }) }))
vi.mock("@/lib/inbox/realtime", () => ({ getInboxDeltas: (a: unknown) => getInboxDeltasMock(a) }))

import { GET } from "./route"

beforeEach(() => {
  vi.clearAllMocks()
  requireCommsAgentMock.mockResolvedValue({ user: { id: "u1", email: "a@b.c", role: "ADMIN" } })
  getInboxDeltasMock.mockResolvedValue({ conversations: [], cursor: "2026-07-05T12:00:00.000Z" })
})

it("passes queue + since through", async () => {
  const res = await GET(new NextRequest("http://x/api/inbox/deltas?queue=all&since=2026-07-05T11:00:00.000Z"))
  expect(res.status).toBe(200)
  expect(getInboxDeltasMock).toHaveBeenCalledWith({ tenantId: "t1", agentUserId: "u1", queue: "all", since: "2026-07-05T11:00:00.000Z" })
})

it("since defaults to null on first poll", async () => {
  await GET(new NextRequest("http://x/api/inbox/deltas?queue=mine"))
  expect(getInboxDeltasMock).toHaveBeenCalledWith(expect.objectContaining({ since: null }))
})

it("403 propagates from the guard and short-circuits", async () => {
  const { NextResponse } = await import("next/server")
  requireCommsAgentMock.mockResolvedValue({ error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) })
  const res = await GET(new NextRequest("http://x/api/inbox/deltas"))
  expect(res.status).toBe(403)
  expect(getInboxDeltasMock).not.toHaveBeenCalled()
})
