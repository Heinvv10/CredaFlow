import { NextRequest } from "next/server"
import { beforeEach, describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => ({ session: null as null | { user: Record<string, unknown> }, confirm: vi.fn() }))
vi.mock("@/lib/auth", () => ({ auth: async () => h.session }))
vi.mock("@/lib/tenant", () => ({ withTenantContext: (_req: unknown, fn: (t: { id: string }) => unknown) => fn({ id: "t1" }) }))
vi.mock("@/lib/contact/identity-confirmation", async (orig) => ({ ...(await orig<typeof import("@/lib/contact/identity-confirmation")>()), confirmContactIdentity: h.confirm }))

import { POST } from "./route"

const staff = (role: string) => ({ user: { id: "u2", email: "o@x.invalid", role, tenantId: "t1" } })
const call = (body: unknown = { channel: "EMAIL", note: "Called the borrower back on file." }) =>
  POST(new NextRequest("http://localhost/x", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }), { params: Promise.resolve({ id: "c1" }) })

// The real role guard: this is what lets a signing code go to an address.
describe("POST contact-identity-confirmation", () => {
  beforeEach(() => { h.confirm.mockReset(); h.confirm.mockResolvedValue({ ok: true }) })

  it.each([[null, 401], [staff("READONLY"), 403], [staff("COLLECTIONS_AGENT"), 403], [staff("CLIENT"), 403]])("refuses %j", async (session, status) => {
    h.session = session as typeof h.session
    expect((await call()).status).toBe(status)
    expect(h.confirm).not.toHaveBeenCalled()
  })

  it("confirms for a credit officer, in their name, with their note", async () => {
    h.session = staff("CREDIT_OFFICER")
    expect((await call()).status).toBe(200)
    expect(h.confirm).toHaveBeenCalledWith(expect.objectContaining({ tenantId: "t1", clientId: "c1", channel: "EMAIL", by: expect.objectContaining({ type: "staff", id: "u2", note: "Called the borrower back on file." }) }))
  })

  it("wants a channel it knows and a note that says something", async () => {
    h.session = staff("CREDIT_OFFICER")
    expect((await call({ channel: "SMS", note: "Called the borrower back." })).status).toBe(400)
    expect((await call({ channel: "EMAIL", note: "ok" })).status).toBe(400)
    expect(h.confirm).not.toHaveBeenCalled()
  })

  it("passes the setter's refusal through", async () => {
    h.session = staff("CREDIT_OFFICER")
    h.confirm.mockResolvedValue({ ok: false, status: 403, error: "You set this address, so someone else must confirm it." })
    expect((await call()).status).toBe(403)
  })
})
