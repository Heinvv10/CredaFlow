/* eslint-disable @typescript-eslint/no-explicit-any */
import { it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const requireApiRoleMock = vi.fn()
const listMock = vi.fn()
vi.mock("@/lib/auth-guards", () => ({ requireApiRole: () => requireApiRoleMock() }))
vi.mock("@/lib/tenant", () => ({ withTenantContext: (req: unknown, cb: (t: any) => Promise<unknown>) => cb({ id: "t1", name: "T" }) }))
vi.mock("@/lib/inbox/roster", () => ({ listStaffForRoster: (t: string) => listMock(t) }))

import { GET } from "./route"
const req = () => new NextRequest("http://x/api/staff/mentionable")

beforeEach(() => {
  vi.clearAllMocks()
  requireApiRoleMock.mockResolvedValue({ user: { id: "u1", email: "a@b.c", role: "READONLY" } })
})

it("401s without a session", async () => {
  const { NextResponse } = await import("next/server")
  requireApiRoleMock.mockResolvedValue({ error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) })
  const res = await GET(req())
  expect(res.status).toBe(401)
  expect(listMock).not.toHaveBeenCalled()
})

it("returns id, name and email only", async () => {
  listMock.mockResolvedValue([{ id: "u1", name: "Ana", email: "ana@example.test", role: "ADMIN", isCommsAgent: true }])
  const res = await GET(req())
  expect(await res.json()).toEqual([{ id: "u1", name: "Ana", email: "ana@example.test" }])
})
