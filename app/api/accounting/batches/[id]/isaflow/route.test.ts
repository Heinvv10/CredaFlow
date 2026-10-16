import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const h = vi.hoisted(() => ({
  session: null as null | { user: Record<string, unknown> },
  push: vi.fn(),
  check: vi.fn(),
  resolve: vi.fn(),
}))

vi.mock("next/navigation", () => ({ redirect: vi.fn() }))
vi.mock("@/lib/auth", () => ({ auth: async () => h.session }))
vi.mock("@/lib/tenant", () => ({ withTenantContext: (_req: unknown, fn: (t: { id: string }) => Promise<Response>) => fn({ id: "t1" }) }))
vi.mock("@/lib/prisma", () => ({ prisma: {} }))
// The lender's 2FA policy says "off": the push must still demand a verified code.
vi.mock("@/lib/security/staff-totp-policy", () => ({ isStaffTotpRequired: async () => false }))
vi.mock("@/lib/accounting/isaflow/push", () => ({
  pushBatchToIsaFlow: (...a: unknown[]) => h.push(...a),
  resolveIsaFlowPush: (...a: unknown[]) => h.resolve(...a),
}))
vi.mock("@/lib/accounting/isaflow/retry", () => ({ checkIsaFlowPush: (...a: unknown[]) => h.check(...a) }))

import { POST } from "./route"

const caller = (role: string, extra: Record<string, unknown> = {}) => ({
  user: { id: "admin-1", email: "admin@lender.example", role, tenantId: "t1", totpVerified: true, tokenVersion: 1, ...extra },
})
const post = (body: unknown) => POST(
  new NextRequest("http://localhost/api/accounting/batches/b-1/isaflow", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  { params: Promise.resolve({ id: "b-1" }) },
)
const actor = { id: "admin-1", email: "admin@lender.example" }

beforeEach(() => {
  h.session = caller("ADMIN")
  h.push.mockReset().mockResolvedValue({ ok: true, status: "PUSHED", journalId: "j-1", foundOnReadBack: false })
  h.check.mockReset()
  h.resolve.mockReset().mockResolvedValue(true)
})

describe("POST /api/accounting/batches/[id]/isaflow", () => {
  it("pushes the tenant's batch for an ADMIN whose session verified TOTP", async () => {
    const res = await post({ action: "push" })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ status: "PUSHED", journalId: "j-1" })
    expect(h.push).toHaveBeenCalledWith({}, { tenantId: "t1", batchId: "b-1", actor })
  })

  it("refuses an ADMIN or a SUPER_ADMIN without a verified TOTP code, even with the lender's 2FA off", async () => {
    h.session = caller("ADMIN", { totpVerified: false })
    expect((await post({ action: "push" })).status).toBe(403)
    h.session = caller("SUPER_ADMIN", { totpVerified: false })
    expect((await post({ action: "push" })).status).toBe(403)
    h.session = caller("LOAN_ADMIN")
    expect((await post({ action: "push" })).status).toBe(403)
    expect(h.push).not.toHaveBeenCalled()
  })

  it("answers with the push's own status: another tenant's batch is 404, a refused month 422", async () => {
    h.push.mockResolvedValueOnce({ ok: false, httpStatus: 404, status: null, error: "Closed batch not found" })
    expect((await post({ action: "push" })).status).toBe(404)
    h.push.mockResolvedValueOnce({ ok: false, httpStatus: 422, status: null, error: "IsaFlow cannot take these account codes: 9999 (not in IsaFlow)" })
    expect((await post({ action: "push" })).status).toBe(422)
  })

  it("checks a push without an answer", async () => {
    h.check.mockResolvedValue({ ok: true, status: "PUSHED", journalId: "j-1", foundOnReadBack: true })
    expect(await (await post({ action: "check" })).json()).toMatchObject({ foundOnReadBack: true })
    expect(h.check).toHaveBeenCalledWith({}, { tenantId: "t1", batchId: "b-1", actor })
  })

  it("resolves only with an outcome, a note, and the journal id when it is there", async () => {
    expect((await post({ action: "resolve", outcome: "pushed", note: "found it" })).status).toBe(400)
    expect((await post({ action: "resolve", outcome: "not_pushed", note: "no" })).status).toBe(400)
    expect((await post({ action: "resolve", outcome: "maybe", note: "checked IsaFlow" })).status).toBe(400)
    expect((await post({ action: "resolve", outcome: "pushed", journalId: "j-9", note: "found it in drafts" })).status).toBe(200)
    expect(h.resolve).toHaveBeenCalledWith({}, { tenantId: "t1", batchId: "b-1", outcome: "pushed", journalId: "j-9", note: "found it in drafts", actor })
    h.resolve.mockResolvedValueOnce(false)
    expect((await post({ action: "resolve", outcome: "not_pushed", note: "not in drafts" })).status).toBe(409)
    expect((await post({ action: "other" })).status).toBe(400)
  })
})
