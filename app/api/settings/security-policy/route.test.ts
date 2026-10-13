import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const h = vi.hoisted(() => ({
  session: null as null | { user: Record<string, unknown> },
  locked: vi.fn(),
  apply: vi.fn(),
}))

vi.mock("next/navigation", () => ({ redirect: vi.fn() }))
vi.mock("@/lib/auth", () => ({ auth: async () => h.session }))
vi.mock("@/lib/tenant", () => ({ withTenantContext: (_req: unknown, fn: (t: { id: string }) => Promise<Response>) => fn({ id: "t1" }) }))
vi.mock("@/lib/rate-limit", () => ({ callerIp: () => "10.0.0.9" }))
vi.mock("@/lib/security/staff-totp-policy", () => ({ applyStaffTotpRequired: (...a: unknown[]) => h.apply(...a) }))
vi.mock("@/lib/prisma", () => {
  const tx = { $executeRaw: async () => 1, $queryRaw: (...a: unknown[]) => h.locked(...a), auditLog: { create: vi.fn() } }
  return { prisma: { $transaction: async (fn: (t: typeof tx) => unknown) => fn(tx) } }
})

import { PUT } from "./route"

const caller = (role: string, extra: Record<string, unknown> = {}) => ({
  user: { id: "super-1", email: "super@lender.example", name: "S", role, tenantId: "t1", totpVerified: true, tokenVersion: 2, ...extra },
})
const put = (body: unknown) => PUT(new NextRequest("http://localhost/api/settings/security-policy", {
  method: "PUT", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body),
}))
const row = (role: string) => ({ id: "super-1", role, active: true, tokenVersion: 2 })

beforeEach(() => {
  h.session = caller("SUPER_ADMIN")
  h.locked.mockReset().mockResolvedValue([row("SUPER_ADMIN")])
  h.apply.mockReset().mockResolvedValue({ changed: true, required: false, signedOut: 2 })
})

describe("PUT /api/settings/security-policy", () => {
  it("switches the setting for the session's tenant, naming the actor, and reports the outcome", async () => {
    const res = await put({ requireStaffTotp: false })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, changed: true, requireStaffTotp: false, signedOutUsers: 2 })
    expect(h.apply).toHaveBeenCalledWith(
      expect.anything(),
      { tenantId: "t1", actor: { id: "super-1", email: "super@lender.example" }, required: false, ipAddress: "10.0.0.9" },
    )
  })

  it("is for a SUPER_ADMIN only", async () => {
    for (const role of ["READONLY", "CREDIT_OFFICER", "BRANCH_MANAGER", "ADMIN"]) {
      h.session = caller(role)
      expect((await put({ requireStaffTotp: false })).status, role).toBe(403)
    }
    h.session = null
    expect((await put({ requireStaffTotp: false })).status).toBe(401)
    expect(h.apply).not.toHaveBeenCalled()
  })

  // Switching it off is a change like switching it on.
  it.each([true, false])("needs a TOTP-verified session to switch it to %s", async (value) => {
    h.session = caller("SUPER_ADMIN", { totpVerified: false })
    const res = await put({ requireStaffTotp: value })
    expect(res.status).toBe(403)
    expect((await res.json()).error).toMatch(/change the security policy/)
    expect(h.apply).not.toHaveBeenCalled()
  })

  it("refuses a caller who is no longer a SUPER_ADMIN on the locked row", async () => {
    h.locked.mockResolvedValue([row("ADMIN")])
    expect((await put({ requireStaffTotp: false })).status).toBe(403)
    h.locked.mockResolvedValue([{ ...row("SUPER_ADMIN"), tokenVersion: 3 }])
    const stale = await put({ requireStaffTotp: false })
    expect(stale.status).toBe(403)
    expect((await stale.json()).error).toMatch(/out of date/)
    expect(h.apply).not.toHaveBeenCalled()
  })

  it.each([undefined, null, "false", 0, {}, []])("refuses requireStaffTotp = %j with 400", async (value) => {
    expect((await put({ requireStaffTotp: value })).status).toBe(400)
    expect(h.apply).not.toHaveBeenCalled()
  })

  it("refuses a body that is not JSON with 400", async () => {
    expect((await put("{not json")).status).toBe(400)
  })
})
