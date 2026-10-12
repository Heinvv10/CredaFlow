/* eslint-disable @typescript-eslint/no-explicit-any */
import { it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const requireCommsAgentMock = vi.fn()
const requireApiRoleMock = vi.fn()
const listStaffMock = vi.fn()
const setAgentMock = vi.fn()
const userFindFirstMock = vi.fn()
const logAuditStrictMock = vi.fn()
// The caller's and target's rows as the toggle's transaction locks them.
const lockedRowsMock = vi.fn()
const tx = { $queryRaw: (...a: unknown[]) => lockedRowsMock(...a), auditLog: { create: vi.fn() } }
vi.mock("next/navigation", () => ({ redirect: vi.fn() }))
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }))
vi.mock("@/lib/prisma", () => ({ prisma: { user: { findFirst: (a: unknown) => userFindFirstMock(a) }, $transaction: (fn: (t: unknown) => unknown) => fn(tx) } }))
vi.mock("@/lib/audit", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/audit")>()), logAuditStrict: (...a: unknown[]) => logAuditStrictMock(...a) }))
vi.mock("@/lib/inbox/authz", () => ({ requireCommsAgent: () => requireCommsAgentMock() }))
// Only the session guard is mocked: the staff-user write gate is the real one.
vi.mock("@/lib/auth-guards", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/auth-guards")>()), requireApiRole: () => requireApiRoleMock() }))
vi.mock("@/lib/tenant", () => ({ withTenantContext: (req: unknown, cb: (t: any) => Promise<unknown>) => cb({ id: "t1", name: "T" }) }))
vi.mock("@/lib/inbox/roster", () => ({ listStaffForRoster: (t: unknown) => listStaffMock(t), setCommsAgent: (...a: unknown[]) => setAgentMock(...a) }))

import { GET, PATCH } from "./route"
beforeEach(() => {
  vi.clearAllMocks()
  requireCommsAgentMock.mockResolvedValue({ user: { id: "u1", email: "a@b.c", role: "ADMIN" } })
  requireApiRoleMock.mockResolvedValue({ user: { id: "admin1", email: "ad@b.c", role: "ADMIN", totpVerified: true } })
  userFindFirstMock.mockResolvedValue({ role: "CREDIT_OFFICER" })
  logAuditStrictMock.mockReset()
  lockedRowsMock.mockImplementation(async () => [{ id: "admin1", role: "ADMIN", active: true }, { id: "u2", role: (await userFindFirstMock.mock.results.at(-1)?.value)?.role, active: true }])
})

const toggle = () => PATCH(new NextRequest("http://x/api/inbox/roster", { method: "PATCH", body: JSON.stringify({ userId: "u2", isCommsAgent: true }) }))

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
  // Inside the locked transaction, so the flag and its audit row commit together.
  expect(setAgentMock).toHaveBeenCalledWith({ tenantId: "t1", userId: "u2", isCommsAgent: true, actorUserId: "admin1", actorEmail: "ad@b.c" }, tx)
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

it("PATCH refuses a member who outranks the caller, audits the attempt and toggles nothing", async () => {
  userFindFirstMock.mockResolvedValue({ role: "SUPER_ADMIN" })
  const res = await toggle()
  expect(res.status).toBe(403)
  expect(setAgentMock).not.toHaveBeenCalled()
  expect(logAuditStrictMock).toHaveBeenCalledWith(expect.objectContaining({
    tenantId: "t1", userId: "admin1", action: "USER_WRITE_REFUSED", entityId: "u2",
    newValue: expect.objectContaining({ reason: "target_outranks_caller", targetRole: "SUPER_ADMIN" }),
  }), undefined)
})

it("PATCH lets an ADMIN toggle a fellow ADMIN", async () => {
  userFindFirstMock.mockResolvedValue({ role: "ADMIN" })
  setAgentMock.mockResolvedValue({ ok: true })
  expect((await toggle()).status).toBe(200)
  expect(setAgentMock).toHaveBeenCalledTimes(1)
})

it.each([false, undefined])("PATCH refuses a session whose sign-in did not verify TOTP (%j) and toggles nothing", async (totpVerified) => {
  requireApiRoleMock.mockResolvedValue({ user: { id: "admin1", email: "ad@b.c", role: "ADMIN", totpVerified } })
  const res = await toggle()
  expect(res.status).toBe(403)
  expect((await res.json()).error).toMatch(/two-factor/)
  expect(setAgentMock).not.toHaveBeenCalled()
})

it("PATCH answers 404 for a member outside the caller's tenant and toggles nothing", async () => {
  userFindFirstMock.mockResolvedValue(null)
  const res = await toggle()
  expect(res.status).toBe(404)
  expect(userFindFirstMock).toHaveBeenCalledWith({ where: { id: "u2", tenantId: "t1" }, select: { role: true } })
  expect(setAgentMock).not.toHaveBeenCalled()
})

// A JSON object is not an id: Prisma would read {"startsWith":""} as a filter
// and the update would flip every matching user, senior ones included.
it.each([{ startsWith: "" }, { not: "admin1" }, ["u2"], 7])("PATCH rejects a userId that is not a string (%j) and toggles nothing", async (userId) => {
  const res = await PATCH(new NextRequest("http://x/api/inbox/roster", { method: "PATCH", body: JSON.stringify({ userId, isCommsAgent: true }) }))
  expect(res.status).toBe(400)
  expect(userFindFirstMock).not.toHaveBeenCalled()
  expect(setAgentMock).not.toHaveBeenCalled()
})

it("PATCH toggles nothing when the refused attempt cannot be audited", async () => {
  userFindFirstMock.mockResolvedValue({ role: "SUPER_ADMIN" })
  logAuditStrictMock.mockRejectedValue(new Error("audit table unavailable"))
  await expect(toggle()).rejects.toThrow("audit table unavailable")
  expect(setAgentMock).not.toHaveBeenCalled()
})

// The first check reads the member's role; the toggle re-checks it on the row
// its transaction has locked, so a promotion in between cannot be carried over.
it("PATCH refuses a member promoted above the caller after the first check, audits it in the transaction and toggles nothing", async () => {
  lockedRowsMock.mockResolvedValue([{ id: "admin1", role: "ADMIN", active: true }, { id: "u2", role: "SUPER_ADMIN", active: true }])
  const res = await toggle()
  expect(res.status).toBe(403)
  expect(setAgentMock).not.toHaveBeenCalled()
  expect(logAuditStrictMock).toHaveBeenCalledWith(expect.objectContaining({
    action: "USER_WRITE_REFUSED", newValue: expect.objectContaining({ targetRole: "SUPER_ADMIN" }),
  }), tx)
})

it("PATCH refuses a caller deactivated after the first check and toggles nothing", async () => {
  lockedRowsMock.mockResolvedValue([{ id: "admin1", role: "ADMIN", active: false }, { id: "u2", role: "CREDIT_OFFICER", active: true }])
  expect((await toggle()).status).toBe(403)
  expect(setAgentMock).not.toHaveBeenCalled()
})
