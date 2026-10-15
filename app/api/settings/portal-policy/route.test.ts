import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const h = vi.hoisted(() => ({
  session: null as null | { user: Record<string, unknown> },
  locked: vi.fn(),
  stored: null as null | Record<string, unknown>,
  upsert: vi.fn(),
  audit: vi.fn(),
}))

vi.mock("next/navigation", () => ({ redirect: vi.fn() }))
vi.mock("@/lib/auth", () => ({ auth: async () => h.session }))
vi.mock("@/lib/tenant", () => ({ withTenantContext: (_req: unknown, fn: (t: { id: string }) => Promise<Response>) => fn({ id: "t1" }) }))
vi.mock("@/lib/rate-limit", () => ({ callerIp: () => "192.0.2.9" }))
vi.mock("@/lib/prisma", () => {
  const tx = {
    $executeRaw: async () => 1,
    $queryRaw: (...a: unknown[]) => h.locked(...a),
    tenantConfig: { findUnique: async () => h.stored, upsert: (...a: unknown[]) => h.upsert(...a) },
    auditLog: { create: (...a: unknown[]) => h.audit(...a) },
  }
  return { prisma: { $transaction: async (fn: (t: typeof tx) => unknown) => fn(tx) } }
})

import { PUT } from "./route"

const caller = (role: string, extra: Record<string, unknown> = {}) => ({
  user: { id: "super-1", email: "super@lender.example", name: "S", role, tenantId: "t1", totpVerified: true, tokenVersion: 2, ...extra },
})
const put = (body: unknown) => PUT(new NextRequest("http://localhost/api/settings/portal-policy", {
  method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
}))
const next = { requireSigningOtp: true, signingOtpBranchExempt: false, allowNewRegistrations: false }

beforeEach(() => {
  h.session = caller("SUPER_ADMIN")
  h.stored = null
  h.locked.mockReset().mockResolvedValue([{ id: "super-1", role: "SUPER_ADMIN", active: true, tokenVersion: 2 }])
  h.upsert.mockReset().mockResolvedValue({})
  h.audit.mockReset().mockResolvedValue({})
})

describe("PUT /api/settings/portal-policy", () => {
  it("saves the three switches and audits the defaults it replaced", async () => {
    const res = await put(next)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, changed: true, ...next })
    expect(h.upsert).toHaveBeenCalledWith({ where: { tenantId: "t1" }, update: next, create: { tenantId: "t1", ...next } })
    expect(h.audit).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "PORTAL_POLICY_UPDATED",
        oldValue: { allowNewRegistrations: true, requireSigningOtp: true, signingOtpBranchExempt: true },
        newValue: next,
      }),
    })
  })

  it("writes nothing when nothing changed", async () => {
    h.stored = { ...next }
    expect(await (await put(next)).json()).toEqual(expect.objectContaining({ changed: false }))
    expect(h.upsert).not.toHaveBeenCalled()
    expect(h.audit).not.toHaveBeenCalled()
  })

  it("needs all three booleans", async () => {
    expect((await put({ requireSigningOtp: true })).status).toBe(400)
    expect((await put({ ...next, allowNewRegistrations: "no" })).status).toBe(400)
  })

  it("is for a TOTP-verified SUPER_ADMIN only", async () => {
    h.session = caller("ADMIN")
    expect((await put(next)).status).toBe(403)
    h.session = caller("SUPER_ADMIN", { totpVerified: false })
    expect((await put(next)).status).toBe(403)
    expect(h.upsert).not.toHaveBeenCalled()
  })
})
