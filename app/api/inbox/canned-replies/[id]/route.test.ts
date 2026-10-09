/* eslint-disable @typescript-eslint/no-explicit-any */
import { it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const requireApiRoleMock = vi.fn()
const updateMock = vi.fn()
const deleteMock = vi.fn()
vi.mock("@/lib/auth-guards", () => ({ requireApiRole: () => requireApiRoleMock() }))
vi.mock("@/lib/tenant", () => ({ withTenantContext: (req: unknown, cb: (t: any) => Promise<unknown>) => cb({ id: "t1", name: "T" }) }))
vi.mock("@/lib/inbox/canned-replies", () => ({
  updateCannedReply: (a: unknown) => updateMock(a),
  deleteCannedReply: (a: unknown) => deleteMock(a),
}))

import { PATCH, DELETE } from "./route"
const ctx = { params: Promise.resolve({ id: "cr1" }) }
const patchReq = (body: unknown) => new NextRequest("http://x/api/inbox/canned-replies/cr1", { method: "PATCH", body: JSON.stringify(body) })
const deleteReq = () => new NextRequest("http://x/api/inbox/canned-replies/cr1", { method: "DELETE" })

beforeEach(() => {
  vi.clearAllMocks()
  requireApiRoleMock.mockResolvedValue({ user: { id: "admin1", email: "ad@b.c", role: "ADMIN" } })
})

it("PATCH updates a canned reply", async () => {
  updateMock.mockResolvedValue({ ok: true })
  const res = await PATCH(patchReq({ title: "New title" }), ctx)
  expect(res.status).toBe(200)
  expect(updateMock).toHaveBeenCalledWith({ tenantId: "t1", id: "cr1", title: "New title", body: undefined, actorUserId: "admin1", actorEmail: "ad@b.c" })
})

it("PATCH 404 on missing canned reply", async () => {
  updateMock.mockResolvedValue({ ok: false })
  const res = await PATCH(patchReq({ title: "New title" }), ctx)
  expect(res.status).toBe(404)
})

it("PATCH short-circuits on guard failure without calling updateCannedReply", async () => {
  const { NextResponse } = await import("next/server")
  requireApiRoleMock.mockResolvedValue({ error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) })
  const res = await PATCH(patchReq({ title: "New title" }), ctx)
  expect(res.status).toBe(403)
  expect(updateMock).not.toHaveBeenCalled()
})

it("DELETE removes a canned reply", async () => {
  deleteMock.mockResolvedValue({ ok: true })
  const res = await DELETE(deleteReq(), ctx)
  expect(res.status).toBe(200)
  expect(deleteMock).toHaveBeenCalledWith({ tenantId: "t1", id: "cr1", actorUserId: "admin1", actorEmail: "ad@b.c" })
})

it("DELETE 404 on missing canned reply", async () => {
  deleteMock.mockResolvedValue({ ok: false })
  const res = await DELETE(deleteReq(), ctx)
  expect(res.status).toBe(404)
})

it("DELETE short-circuits on guard failure without calling deleteCannedReply", async () => {
  const { NextResponse } = await import("next/server")
  requireApiRoleMock.mockResolvedValue({ error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) })
  const res = await DELETE(deleteReq(), ctx)
  expect(res.status).toBe(403)
  expect(deleteMock).not.toHaveBeenCalled()
})
