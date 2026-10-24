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
vi.mock("@/lib/learning-loop/retention/policy", async (original) => ({
  ...(await original<typeof import("@/lib/learning-loop/retention/policy")>()),
  applyDecisionRecordRetention: (...a: unknown[]) => h.apply(...a),
}))
vi.mock("@/lib/prisma", () => {
  const tx = { $executeRaw: async () => 1, $queryRaw: (...a: unknown[]) => h.locked(...a), auditLog: { create: vi.fn() } }
  return { prisma: { $transaction: async (fn: (t: typeof tx) => unknown) => fn(tx) } }
})

import { PUT } from "./route"

const caller = (role: string, extra: Record<string, unknown> = {}) => ({
  user: { id: "super-1", email: "super@lender.example", name: "S", role, tenantId: "t1", totpVerified: true, tokenVersion: 2, ...extra },
})
const put = (body: unknown) => PUT(new NextRequest("http://localhost/api/settings/decision-record-retention", {
  method: "PUT", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body),
}))
const row = (role: string) => ({ id: "super-1", role, active: true, tokenVersion: 2 })

beforeEach(() => {
  h.session = caller("SUPER_ADMIN")
  h.locked.mockReset().mockResolvedValue([row("SUPER_ADMIN")])
  h.apply.mockReset().mockResolvedValue({ changed: true, months: 60 })
})

describe("PUT /api/settings/decision-record-retention", () => {
  it("sets the period for the session's tenant through the audited writer, naming the actor", async () => {
    const res = await put({ months: 60 })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, changed: true, decisionRecordRetentionMonths: 60 })
    expect(h.apply).toHaveBeenCalledWith(
      expect.anything(),
      { tenantId: "t1", actor: { id: "super-1", email: "super@lender.example" }, months: 60, ipAddress: "10.0.0.9" },
    )
  })

  it("switches retention off with null", async () => {
    h.apply.mockResolvedValue({ changed: true, months: null })
    expect((await put({ months: null })).status).toBe(200)
    expect(h.apply).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ months: null }))
  })

  it("is for a SUPER_ADMIN only: 403 for every other role, 401 with no session", async () => {
    for (const role of ["READONLY", "CREDIT_OFFICER", "BRANCH_MANAGER", "ADMIN"]) {
      h.session = caller(role)
      expect((await put({ months: 60 })).status, role).toBe(403)
    }
    h.session = null
    expect((await put({ months: 60 })).status).toBe(401)
    expect(h.apply).not.toHaveBeenCalled()
  })

  it.each([60, null])("needs a TOTP-verified session to set it to %s", async (months) => {
    h.session = caller("SUPER_ADMIN", { totpVerified: false })
    const res = await put({ months })
    expect(res.status).toBe(403)
    expect((await res.json()).error).toMatch(/two-factor/)
    expect(h.apply).not.toHaveBeenCalled()
  })

  it("refuses a caller who is no longer a SUPER_ADMIN on the locked row, or whose session is stale", async () => {
    h.locked.mockResolvedValue([row("ADMIN")])
    expect((await put({ months: 60 })).status).toBe(403)
    h.locked.mockResolvedValue([{ ...row("SUPER_ADMIN"), tokenVersion: 3 }])
    expect((await put({ months: 60 })).status).toBe(403)
    expect(h.apply).not.toHaveBeenCalled()
  })

  it.each([undefined, "12", 0, 1, 59, 601, 1.5, -3, true, {}, []])("refuses months = %j with 400", async (value) => {
    expect((await put({ months: value })).status).toBe(400)
    expect(h.apply).not.toHaveBeenCalled()
  })

  it("names the 60-month floor when it refuses 59", async () => {
    const res = await put({ months: 59 })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain("from 60 to 600")
  })

  it("refuses a body with no months, or that is not JSON, with 400", async () => {
    expect((await put({})).status).toBe(400)
    expect((await put("{not json")).status).toBe(400)
    expect((await put("null")).status).toBe(400)
  })
})
