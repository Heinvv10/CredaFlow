import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const h = vi.hoisted(() => ({
  session: null as null | { user: Record<string, unknown> },
  totpRequired: true,
  configBefore: vi.fn(),
  upsert: vi.fn(),
  audit: vi.fn(),
  revalidateTag: vi.fn(),
}))

vi.mock("next/navigation", () => ({ redirect: vi.fn() }))
vi.mock("next/cache", () => ({ revalidateTag: (...a: unknown[]) => h.revalidateTag(...a) }))
vi.mock("@/lib/auth", () => ({ auth: async () => h.session }))
vi.mock("@/lib/tenant", () => ({ withTenantContext: (_req: unknown, fn: (t: { id: string }) => Promise<Response>) => fn({ id: "t1" }) }))
vi.mock("@/lib/rate-limit", () => ({ callerIp: () => "10.0.0.9" }))
vi.mock("@/lib/security/staff-totp-policy", () => ({ isStaffTotpRequired: async () => h.totpRequired }))
vi.mock("@/lib/audit", () => ({
  AuditAction: { TENANT_LANGUAGES_UPDATED: "TENANT_LANGUAGES_UPDATED" },
  logAuditStrict: (...a: unknown[]) => h.audit(...a),
}))
vi.mock("@/lib/prisma", () => {
  const tx = {
    $executeRaw: async () => 1,
    tenantConfig: { findUnique: (...a: unknown[]) => h.configBefore(...a), upsert: (...a: unknown[]) => h.upsert(...a) },
  }
  return { prisma: { $transaction: async (fn: (t: typeof tx) => unknown) => fn(tx) } }
})

import { PUT } from "./route"

const caller = (role: string, extra: Record<string, unknown> = {}) => ({
  user: { id: "super-1", email: "super@lender.example", name: "S", role, tenantId: "t1", totpVerified: true, tokenVersion: 2, ...extra },
})
const put = (body: unknown) => PUT(new NextRequest("http://localhost/api/settings/languages", {
  method: "PUT", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body),
}))
const ACK_ZU = { enabledLanguages: ["en", "zu"], languageReviewAcknowledgements: { zu: { reviewer: "T. Reviewer", confirmed: true } } }

beforeEach(() => {
  h.session = caller("SUPER_ADMIN")
  h.totpRequired = true
  h.configBefore.mockReset().mockResolvedValue({ enabledLanguages: ["en"], languageReviews: {} })
  h.upsert.mockReset().mockResolvedValue({})
  h.audit.mockReset().mockResolvedValue(undefined)
  h.revalidateTag.mockReset()
})

describe("PUT /api/settings/languages", () => {
  it("enables a language with a review acknowledgement, recording the actor, auditing and invalidating the cache", async () => {
    const res = await put(ACK_ZU)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ ok: true, changed: true, enabledLanguages: ["en", "zu"] })
    expect(body.languageReviews.zu).toMatchObject({ reviewer: "T. Reviewer", acknowledgedById: "super-1", acknowledgedByEmail: "super@lender.example" })
    expect(h.upsert.mock.calls[0][0].update.languageReviews.zu.reviewer).toBe("T. Reviewer")
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: "t1", userId: "super-1", action: "TENANT_LANGUAGES_UPDATED", ipAddress: "10.0.0.9",
      newValue: { enabledLanguages: ["en", "zu"], reviewAcknowledgements: { zu: "T. Reviewer" } },
    }), expect.anything())
    expect(h.revalidateTag).toHaveBeenCalledWith("tenant-config-t1", { expire: 0 })
  })

  it("refuses to enable a language without a review acknowledgement, writing nothing", async () => {
    const res = await put({ enabledLanguages: ["en", "zu"] })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/native-speaker review before enabling: zu/)
    expect(h.upsert).not.toHaveBeenCalled()
    expect(h.audit).not.toHaveBeenCalled()
  })

  it("is for a SUPER_ADMIN only", async () => {
    for (const role of ["READONLY", "CREDIT_OFFICER", "BRANCH_MANAGER", "ADMIN"]) {
      h.session = caller(role)
      expect((await put(ACK_ZU)).status, role).toBe(403)
    }
    h.session = null
    expect((await put(ACK_ZU)).status).toBe(401)
    expect(h.upsert).not.toHaveBeenCalled()
  })

  it("needs a TOTP-verified session where the tenant requires staff TOTP", async () => {
    h.session = caller("SUPER_ADMIN", { totpVerified: false })
    const res = await put(ACK_ZU)
    expect(res.status).toBe(403)
    expect((await res.json()).error).toMatch(/two-factor/)
    expect(h.upsert).not.toHaveBeenCalled()

    h.totpRequired = false
    expect((await put(ACK_ZU)).status).toBe(200)
  })

  it("refuses a body that is not JSON with 400", async () => {
    expect((await put("{not json")).status).toBe(400)
  })
})
