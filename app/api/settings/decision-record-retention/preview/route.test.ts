import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const h = vi.hoisted(() => ({ session: null as null | { user: Record<string, unknown> }, count: vi.fn() }))

vi.mock("next/navigation", () => ({ redirect: vi.fn() }))
vi.mock("@/lib/auth", () => ({ auth: async () => h.session }))
vi.mock("@/lib/tenant", () => ({ withTenantContext: (_req: unknown, fn: (t: { id: string }) => Promise<Response>) => fn({ id: "t1" }) }))
vi.mock("@/lib/learning-loop/retention/preview", () => ({ countDecisionRecordsAgedBy: (...a: unknown[]) => h.count(...a) }))

import { POST } from "./route"

const caller = (role: string) => ({ user: { id: "u1", email: "u@lender.example", name: "U", role, tenantId: "t1", totpVerified: true, tokenVersion: 1 } })
const post = (body: unknown) => POST(new NextRequest("http://localhost/api/settings/decision-record-retention/preview", {
  method: "POST", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body),
}))

beforeEach(() => {
  h.session = caller("SUPER_ADMIN")
  h.count.mockReset().mockResolvedValue(7)
})

describe("POST /api/settings/decision-record-retention/preview", () => {
  it("counts for the session's tenant and the asked period", async () => {
    const res = await post({ months: 24 })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, months: 24, wouldPseudonymise: 7 })
    expect(h.count).toHaveBeenCalledWith("t1", 24)
  })

  it("is for a SUPER_ADMIN only", async () => {
    for (const role of ["READONLY", "BRANCH_MANAGER", "ADMIN"]) {
      h.session = caller(role)
      expect((await post({ months: 24 })).status, role).toBe(403)
    }
    h.session = null
    expect((await post({ months: 24 })).status).toBe(401)
    expect(h.count).not.toHaveBeenCalled()
  })

  it.each([undefined, null, 0, 601, 1.5, "12"])("refuses months = %j with 400", async (months) => {
    expect((await post({ months })).status).toBe(400)
    expect(h.count).not.toHaveBeenCalled()
  })

  it("refuses a body that is not JSON with 400", async () => {
    expect((await post("{nope")).status).toBe(400)
  })
})
