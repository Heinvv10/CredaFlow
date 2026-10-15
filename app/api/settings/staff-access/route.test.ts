import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const h = vi.hoisted(() => ({
  session: null as null | { user: Record<string, unknown> },
  locked: vi.fn(),
  ip: "192.0.2.9",
  stored: null as null | Record<string, unknown>,
  upsert: vi.fn(),
  audit: vi.fn(),
}))

vi.mock("next/navigation", () => ({ redirect: vi.fn() }))
vi.mock("@/lib/auth", () => ({ auth: async () => h.session }))
vi.mock("@/lib/tenant", () => ({ withTenantContext: (_req: unknown, fn: (t: { id: string }) => Promise<Response>) => fn({ id: "t1" }) }))
vi.mock("@/lib/rate-limit", () => ({ callerIp: () => h.ip }))
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

const HOURS = {
  mon: { start: "08:00", end: "17:00" }, tue: { start: "08:00", end: "17:00" }, wed: null, thu: null,
  fri: { start: "08:00", end: "13:00" }, sat: null, sun: null,
}
const caller = (role: string, extra: Record<string, unknown> = {}) => ({
  user: { id: "super-1", email: "super@lender.example", name: "S", role, tenantId: "t1", totpVerified: true, tokenVersion: 2, ...extra },
})
const put = (body: unknown) => PUT(new NextRequest("http://localhost/api/settings/staff-access", {
  method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
}))

beforeEach(() => {
  h.session = caller("SUPER_ADMIN")
  h.ip = "192.0.2.9"
  h.stored = null
  h.locked.mockReset().mockResolvedValue([{ id: "super-1", role: "SUPER_ADMIN", active: true, tokenVersion: 2 }])
  h.upsert.mockReset().mockResolvedValue({})
  h.audit.mockReset().mockResolvedValue({})
})

describe("PUT /api/settings/staff-access", () => {
  it("saves validated hours and allowlist and audits old and new", async () => {
    const res = await put({ staffAccessHours: HOURS, staffIpAllowlist: "192.0.2.0/24\n2001:db8::/32" })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(expect.objectContaining({
      changed: true, staffIpAllowlist: ["192.0.2.0/24", "2001:db8::/32"], callerIpAllowed: true,
    }))
    expect(h.upsert).toHaveBeenCalledWith(expect.objectContaining({
      update: { staffAccessHours: HOURS, staffIpAllowlist: ["192.0.2.0/24", "2001:db8::/32"] },
    }))
    expect(h.audit).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "STAFF_ACCESS_POLICY_UPDATED",
        userId: "super-1",
        oldValue: { hours: null, ipAllowlist: [] },
        newValue: { hours: HOURS, ipAllowlist: ["192.0.2.0/24", "2001:db8::/32"] },
      }),
    })
  })

  it("writes and audits nothing when the policy is unchanged, whatever order JSONB returned the keys in", async () => {
    const reordered = Object.fromEntries(Object.entries(HOURS).reverse().map(([d, w]) => [d, w && { end: w.end, start: w.start }]))
    h.stored = { staffAccessHours: reordered, staffIpAllowlist: ["192.0.2.0/24"] }
    const res = await put({ staffAccessHours: HOURS, staffIpAllowlist: ["192.0.2.0/24"] })
    expect(await res.json()).toEqual(expect.objectContaining({ changed: false }))
    expect(h.upsert).not.toHaveBeenCalled()
    expect(h.audit).not.toHaveBeenCalled()
  })

  it("refuses bad hours and bad CIDR with the field named", async () => {
    const badHours = await put({ staffAccessHours: { ...HOURS, mon: { start: "17:00", end: "08:00" } }, staffIpAllowlist: [] })
    expect(badHours.status).toBe(422)
    expect(await badHours.json()).toEqual(expect.objectContaining({ field: "staffAccessHours" }))
    const badIp = await put({ staffAccessHours: null, staffIpAllowlist: ["192.0.2.0/40"] })
    expect(badIp.status).toBe(422)
    expect(await badIp.json()).toEqual(expect.objectContaining({ field: "staffIpAllowlist" }))
    expect(h.upsert).not.toHaveBeenCalled()
  })

  it("refuses an allowlist on a deployment that cannot see caller addresses", async () => {
    h.ip = "unknown"
    const res = await put({ staffAccessHours: null, staffIpAllowlist: ["192.0.2.0/24"] })
    expect(res.status).toBe(422)
    expect((await res.json()).error).toMatch(/TRUSTED_PROXY/)
    // Lifting the allowlist is still allowed.
    expect((await put({ staffAccessHours: null, staffIpAllowlist: [] })).status).toBe(200)
  })

  it("is for a TOTP-verified SUPER_ADMIN only", async () => {
    for (const role of ["ADMIN", "BRANCH_MANAGER"]) {
      h.session = caller(role)
      expect((await put({ staffAccessHours: null, staffIpAllowlist: [] })).status, role).toBe(403)
    }
    h.session = caller("SUPER_ADMIN", { totpVerified: false })
    expect((await put({ staffAccessHours: null, staffIpAllowlist: [] })).status).toBe(403)
    h.session = caller("SUPER_ADMIN")
    h.locked.mockResolvedValue([{ id: "super-1", role: "ADMIN", active: true, tokenVersion: 2 }])
    expect((await put({ staffAccessHours: null, staffIpAllowlist: [] })).status).toBe(403)
    expect(h.upsert).not.toHaveBeenCalled()
  })

  it("needs both fields, so a partial save cannot silently lift a restriction", async () => {
    expect((await put({ staffAccessHours: HOURS })).status).toBe(400)
  })
})
