/* eslint-disable @typescript-eslint/no-explicit-any */
import { it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const requireCommsAgentMock = vi.fn()
const requireApiRoleMock = vi.fn()
const listStaffMock = vi.fn()
const setAgentMock = vi.fn()
vi.mock("@/lib/inbox/authz", () => ({ requireCommsAgent: () => requireCommsAgentMock() }))
vi.mock("@/lib/auth-guards", () => ({ requireApiRole: () => requireApiRoleMock() }))
vi.mock("@/lib/tenant", () => ({ withTenantContext: (req: unknown, cb: (t: any) => Promise<unknown>) => cb({ id: "t1", name: "T" }) }))
vi.mock("@/lib/inbox/roster", () => ({ listStaffForRoster: (t: unknown) => listStaffMock(t), setCommsAgent: (a: unknown) => setAgentMock(a) }))

import { GET, PATCH } from "./route"
beforeEach(() => {
  vi.clearAllMocks()
  requireCommsAgentMock.mockResolvedValue({ user: { id: "u1", email: "a@b.c", role: "ADMIN" } })
  requireApiRoleMock.mockResolvedValue({ user: { id: "admin1", email: "ad@b.c", role: "ADMIN" } })
})

it("GET lists roster", async () => {
  listStaffMock.mockResolvedValue([{ id: "u1" }])
  const res = await GET(new NextRequest("http://x/api/inbox/roster"))
  expect(res.status).toBe(200)
  expect(listStaffMock).toHaveBeenCalledWith("t1")
})

it("PATCH toggles a member", async () => {
  setAgentMock.mockResolvedValue({ ok: true })
  const res = await PATCH(new NextRequest("http://x/api/inbox/roster", { method: "PATCH", body: JSON.stringify({ userId: "u2", isCommsAgent: true }) }))
  expect(res.status).toBe(200)
  expect(setAgentMock).toHaveBeenCalledWith({ tenantId: "t1", userId: "u2", isCommsAgent: true, actorUserId: "admin1", actorEmail: "ad@b.c" })
})

it("PATCH 400 on missing userId", async () => {
  const res = await PATCH(new NextRequest("http://x/api/inbox/roster", { method: "PATCH", body: JSON.stringify({ isCommsAgent: true }) }))
  expect(res.status).toBe(400)
})

it("GET short-circuits on guard failure without calling listStaffForRoster", async () => {
  const { NextResponse } = await import("next/server")
  requireCommsAgentMock.mockResolvedValue({ error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) })
  const res = await GET(new NextRequest("http://x/api/inbox/roster"))
  expect(res.status).toBe(403)
  expect(listStaffMock).not.toHaveBeenCalled()
})

it("PATCH short-circuits on guard failure without calling setCommsAgent", async () => {
  const { NextResponse } = await import("next/server")
  requireApiRoleMock.mockResolvedValue({ error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) })
  const res = await PATCH(new NextRequest("http://x/api/inbox/roster", { method: "PATCH", body: JSON.stringify({ userId: "u2", isCommsAgent: true }) }))
  expect(res.status).toBe(403)
  expect(setAgentMock).not.toHaveBeenCalled()
})
