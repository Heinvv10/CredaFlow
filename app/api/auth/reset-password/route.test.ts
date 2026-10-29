import { NextRequest } from "next/server"
import { beforeEach, describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => ({ findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn(), audit: vi.fn() }))
vi.mock("@/lib/prisma", () => {
  const tx = { user: { findUnique: h.findUnique, update: h.update, updateMany: h.updateMany }, auditLog: { create: h.audit } }
  return { prisma: { ...tx, $transaction: (cb: (db: typeof tx) => Promise<unknown>) => cb(tx) } }
})
vi.mock("bcryptjs", () => ({ default: { hash: vi.fn(async () => "hashed") } }))

import { GET, POST } from "./route"

const post = (password: string) => POST(new NextRequest("https://app.example.test/api/auth/reset-password", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ token: "t".repeat(64), password }),
}))

beforeEach(() => {
  vi.clearAllMocks()
  h.updateMany.mockResolvedValue({ count: 1 })
  h.audit.mockResolvedValue({ id: "audit-synthetic" })
  h.findUnique.mockResolvedValue({ tenantId: "tenant-synthetic", email: "staff@example.test", id: "u1", active: true, resetTokenExp: new Date(Date.now() + 60_000) })
})

describe("POST /api/auth/reset-password (staff)", () => {
  it.each(["synth-8c", "password12", "qwerty12345"])("refuses the weak password %s and changes nothing", async (password) => {
    const res = await post(password)
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/at least 10 characters|too common/)
    expect(h.update).not.toHaveBeenCalled()
  })

  it("accepts a long, uncommon password", async () => {
    const res = await post("Mango-Taxi-Umbrella")
    expect(res.status).toBe(200)
    expect(h.updateMany).toHaveBeenCalledOnce()
  })
})


it("audits successful recovery without recording credentials", async () => {
  expect((await post("Mango-Taxi-Umbrella")).status).toBe(200)
  expect(h.audit).toHaveBeenCalledOnce()
  const record = h.audit.mock.calls[0][0].data
  expect(record).toMatchObject({ action: "USER_UPDATED", entityId: "u1", tenantId: "tenant-synthetic", newValue: { passwordChanged: true, resetTokenConsumed: true } })
  expect(JSON.stringify(record)).not.toContain("Mango-Taxi-Umbrella")
  expect(JSON.stringify(record)).not.toContain("hashed")
  expect(JSON.stringify(record)).not.toContain("t".repeat(64))
})
it("fails closed if the transactional audit cannot be written", async () => {
  h.audit.mockRejectedValue(new Error("audit unavailable"))
  await expect(post("Mango-Taxi-Umbrella")).rejects.toThrow("audit unavailable")
})
it("refuses a reset token consumed during password hashing", async () => {
  h.updateMany.mockResolvedValue({ count: 0 })
  expect((await post("Mango-Taxi-Umbrella")).status).toBe(400)
  expect(h.audit).not.toHaveBeenCalled()
})

describe("an SSO-bound user while SSO is on", () => {
  const bound = (over: Record<string, unknown> = {}) => h.findUnique.mockResolvedValue({
    tenantId: "tenant-synthetic", email: "staff@example.test", id: "u1", active: true, role: "CREDIT_OFFICER",
    resetTokenExp: new Date(Date.now() + 60_000), ssoIdentity: { id: "link-1" }, tenant: { ssoConnection: { enabled: true } }, ...over,
  })

  it("cannot use a reset token issued before the binding: nothing is changed", async () => {
    bound()
    const res = await post("Mango-Taxi-Umbrella")
    expect(res.status).toBe(400)
    expect(h.updateMany).not.toHaveBeenCalled()
    expect(h.audit).not.toHaveBeenCalled()
  })

  it("is told the link is not valid when the page checks it", async () => {
    bound()
    const res = await GET(new NextRequest(`https://app.example.test/api/auth/reset-password?token=${"t".repeat(64)}`))
    expect(await res.json()).toEqual({ valid: false })
  })

  it.each([
    ["SSO is off", { tenant: { ssoConnection: { enabled: false } } }],
    ["the user is a Super Admin", { role: "SUPER_ADMIN" }],
    ["there is no binding", { ssoIdentity: null }],
  ])("still resets when %s", async (_l, over) => {
    bound(over)
    expect((await post("Mango-Taxi-Umbrella")).status).toBe(200)
  })
})
