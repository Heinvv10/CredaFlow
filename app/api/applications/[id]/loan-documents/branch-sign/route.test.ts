import { NextRequest } from "next/server"
import { beforeEach, describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => ({ session: null as null | { user: Record<string, unknown> }, sign: vi.fn() }))
vi.mock("@/lib/auth", () => ({ auth: async () => h.session }))
vi.mock("@/lib/tenant", () => ({ withTenantContext: (_req: unknown, fn: (t: { id: string }) => unknown) => fn({ id: "t1" }) }))
vi.mock("@/lib/non-nca-documents/branch-sign", () => ({ signAtBranch: h.sign }))

import { POST } from "./route"

const staff = (role: string) => ({ user: { id: "u1", email: "o@x.invalid", role, tenantId: "t1", totpVerified: true } })
const call = () => POST(new NextRequest("http://localhost/x", { method: "POST", body: JSON.stringify({ witnessAttested: true }), headers: { "content-type": "application/json" } }), { params: Promise.resolve({ id: "a1" }) })

// The real role guard: this route writes a signature, so who reaches it is the control.
describe("POST branch-sign", () => {
  beforeEach(() => { h.sign.mockReset(); h.sign.mockResolvedValue({ ok: true, signedAt: new Date() }) })

  it.each([[null, 401], [staff("READONLY"), 403], [staff("COLLECTIONS_AGENT"), 403], [{ user: { id: "c1", role: "CLIENT", tenantId: "t1", email: "b@x.invalid" } }, 403]])("refuses %j", async (session, status) => {
    h.session = session as typeof h.session
    expect((await call()).status).toBe(status)
    expect(h.sign).not.toHaveBeenCalled()
  })

  it("lets a credit officer through, as the witness, with their own id", async () => {
    h.session = staff("CREDIT_OFFICER")
    expect((await call()).status).toBe(200)
    expect(h.sign).toHaveBeenCalledWith(expect.objectContaining({ applicationId: "a1", tenantId: "t1", staff: { id: "u1", email: "o@x.invalid" }, witnessAttested: true }))
  })

  it("passes a refusal through with the code's reason", async () => {
    h.session = staff("CREDIT_OFFICER")
    h.sign.mockResolvedValue({ ok: false, status: 409, error: "no", signingOtp: "not_found" })
    const res = await call()
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: "no", signingOtp: "not_found" })
  })
})
