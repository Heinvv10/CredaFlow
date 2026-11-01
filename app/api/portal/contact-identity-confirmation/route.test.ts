import { NextRequest } from "next/server"
import { beforeEach, describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => ({ session: null as null | { user: Record<string, unknown> }, confirm: vi.fn() }))
vi.mock("@/lib/auth", () => ({ auth: async () => h.session }))
vi.mock("@/lib/tenant", () => ({ withTenantContext: (_req: unknown, fn: (t: { id: string }) => unknown) => fn({ id: "t1" }) }))
vi.mock("@/lib/contact/identity-confirmation", async (orig) => ({ ...(await orig<typeof import("@/lib/contact/identity-confirmation")>()), confirmContactIdentity: h.confirm }))

import { POST } from "./route"

const call = (body: unknown = { channel: "EMAIL", clientId: "someone-else" }) => POST(new NextRequest("http://localhost/x", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }))

describe("POST /api/portal/contact-identity-confirmation", () => {
  beforeEach(() => { h.confirm.mockReset(); h.confirm.mockResolvedValue({ ok: true }) })

  it("is the borrower's own: no session, staff, and another tenant's session are refused", async () => {
    for (const session of [null, { user: { id: "u1", role: "ADMIN", tenantId: "t1" } }, { user: { id: "c1", role: "CLIENT", tenantId: "t2" } }]) {
      h.session = session
      expect((await call()).status).toBe(401)
    }
    expect(h.confirm).not.toHaveBeenCalled()
  })

  it("confirms for the session's client, whatever the body says", async () => {
    h.session = { user: { id: "c1", role: "CLIENT", tenantId: "t1", email: "b@x.invalid" } }
    expect((await call()).status).toBe(200)
    expect(h.confirm).toHaveBeenCalledWith(expect.objectContaining({ clientId: "c1", by: expect.objectContaining({ type: "client", clientId: "c1" }) }))
  })

  it("refuses a channel it does not know", async () => {
    h.session = { user: { id: "c1", role: "CLIENT", tenantId: "t1" } }
    expect((await call({ channel: "SMS" })).status).toBe(400)
  })
})
