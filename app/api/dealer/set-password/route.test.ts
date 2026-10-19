import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

// The public set-password step: the token is the credential, bound to the
// lender the dealer host resolves; a cross-site write is refused first.
const h = vi.hoisted(() => ({ tenant: null as null | { id: string }, setDealerPassword: vi.fn() }))

vi.mock("@/lib/auth", () => ({ auth: async () => null }))
vi.mock("@/lib/tenant", () => ({ getTenantFromRequest: async () => h.tenant }))
vi.mock("@/lib/dealer/password-links", () => ({ setDealerPassword: h.setDealerPassword }))

import { POST } from "./route"

const req = (headers: Record<string, string> = { "sec-fetch-site": "same-origin" }) => new NextRequest("https://dealers.lender.example/api/dealer/set-password", {
  method: "POST", body: JSON.stringify({ token: "a".repeat(64), password: "Correct-Horse-9" }),
  headers: { host: "dealers.lender.example", "content-type": "application/json", ...headers },
})

beforeEach(() => {
  vi.clearAllMocks()
  h.tenant = { id: "tenant-1" }
  h.setDealerPassword.mockResolvedValue({ kind: "set" })
})

describe("POST /api/dealer/set-password", () => {
  it("sets the password for the host's lender", async () => {
    expect((await POST(req())).status).toBe(200)
    expect(h.setDealerPassword).toHaveBeenCalledWith({ tenantId: "tenant-1", token: "a".repeat(64), password: "Correct-Horse-9" })
  })

  it("passes the library's refusal through", async () => {
    h.setDealerPassword.mockResolvedValue({ kind: "refused", status: 400, error: "This link is invalid or has expired. Ask for a new one." })
    const res = await POST(req())
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/invalid or has expired/)
  })

  it("is 404 on a host that resolves no lender", async () => {
    h.tenant = null
    expect((await POST(req())).status).toBe(404)
    expect(h.setDealerPassword).not.toHaveBeenCalled()
  })

  it("refuses a cross-site write", async () => {
    expect((await POST(req({ "sec-fetch-site": "cross-site" }))).status).toBe(403)
    expect(h.setDealerPassword).not.toHaveBeenCalled()
  })
})
