import { randomBytes } from "node:crypto"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const TOKEN = "pat_route_test_secret_0123456789"
const h = vi.hoisted(() => ({
  session: null as null | { user: Record<string, unknown> },
  locked: vi.fn(),
  row: null as null | Record<string, unknown>,
  upsert: vi.fn(),
  audit: vi.fn(),
  probe: vi.fn(),
  verify: vi.fn(),
}))

vi.mock("next/navigation", () => ({ redirect: vi.fn() }))
vi.mock("@/lib/auth", () => ({ auth: async () => h.session }))
vi.mock("@/lib/tenant", () => ({ withTenantContext: (_req: unknown, fn: (t: { id: string }) => Promise<Response>) => fn({ id: "t1" }) }))
vi.mock("@/lib/rate-limit", () => ({ callerIp: () => "192.0.2.9" }))
vi.mock("@/lib/prisma", () => {
  const isaFlowConnection = {
    findUnique: async () => h.row,
    upsert: async (args: { create: Record<string, unknown> }) => { h.upsert(args); h.row = { ...args.create } },
    updateMany: async () => ({ count: 1 }),
    update: async () => ({}),
  }
  const auditLog = { create: (...a: unknown[]) => h.audit(...a) }
  const tx = { $executeRaw: async () => 1, $queryRaw: (...a: unknown[]) => h.locked(...a), isaFlowConnection, auditLog }
  return { prisma: { $transaction: async (fn: (t: typeof tx) => unknown) => fn(tx), isaFlowConnection, auditLog } }
})
vi.mock("@/lib/accounting/isaflow/connection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/accounting/isaflow/connection")>()),
  probeIsaFlow: (...a: unknown[]) => h.probe(...a),
  verifyProbe: (...a: unknown[]) => h.verify(...a),
}))

import { GET, POST } from "./route"
import { IsaFlowError } from "@/lib/accounting/isaflow/client"

const caller = (role: string, extra: Record<string, unknown> = {}) => ({
  user: { id: "super-1", email: "super@lender.example", name: "S", role, tenantId: "t1", totpVerified: true, tokenVersion: 2, ...extra },
})
const post = (body: unknown) => POST(new NextRequest("http://localhost/api/integrations/isaflow", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
}))
const connect = { action: "connect", baseUrl: "https://isaflow.example", token: TOKEN }
const probe = { origin: "https://isaflow.example", company: { company_id: "c-1", name: "Dev Co", vat_number: null }, accountCount: 42 }
const everything = () => JSON.stringify([h.upsert.mock.calls, h.audit.mock.calls])

beforeEach(() => {
  vi.stubEnv("WABA_ENC_KEY", randomBytes(32).toString("base64"))
  h.session = caller("SUPER_ADMIN")
  h.row = null
  h.locked.mockReset().mockResolvedValue([{ id: "super-1", role: "SUPER_ADMIN", active: true, tokenVersion: 2 }])
  h.upsert.mockReset()
  h.audit.mockReset().mockResolvedValue({})
  h.probe.mockReset().mockResolvedValue(probe)
  h.verify.mockReset().mockResolvedValue(probe)
})

describe("POST /api/integrations/isaflow", () => {
  it("connects for a TOTP-verified SUPER_ADMIN: token sealed, never echoed or audited", async () => {
    const res = await post(connect)
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(JSON.parse(body)).toMatchObject({ status: "CONNECTED", companyName: "Dev Co", baseUrl: "https://isaflow.example" })
    expect(body).not.toContain(TOKEN)
    expect(h.probe).toHaveBeenCalledWith({ baseUrl: "https://isaflow.example", token: TOKEN })
    const data = h.upsert.mock.calls[0][0].create as Record<string, unknown>
    expect(data).toMatchObject({ status: "CONNECTED", connectedById: "super-1", connectedWithTotp: true, isaflowCompanyId: "c-1" })
    expect(String(data.tokenSealed)).toMatch(/^enc:v1:/)
    expect(h.audit).toHaveBeenCalledWith({ data: expect.objectContaining({ action: "ISAFLOW_CONNECTED" }) })
    expect(JSON.stringify(h.audit.mock.calls)).not.toContain(TOKEN)
  })

  it("refuses an ADMIN, and a SUPER_ADMIN whose session did not verify TOTP, before calling IsaFlow", async () => {
    h.session = caller("ADMIN")
    expect((await post(connect)).status).toBe(403)
    h.session = caller("SUPER_ADMIN", { totpVerified: false })
    expect((await post(connect)).status).toBe(403)
    expect(h.probe).not.toHaveBeenCalled()
    expect(h.upsert).not.toHaveBeenCalled()
  })

  it("refuses a SUPER_ADMIN demoted between the check and the write", async () => {
    h.locked.mockResolvedValue([{ id: "super-1", role: "ADMIN", active: true, tokenVersion: 2 }])
    expect((await post(connect)).status).toBe(403)
    expect(h.upsert).not.toHaveBeenCalled()
  })

  it("audits a refused connect without the token, and stores nothing", async () => {
    h.probe.mockRejectedValue(new IsaFlowError("auth", "IsaFlow refused the token (401); connect IsaFlow again with a valid token", 401))
    const res = await post(connect)
    expect(res.status).toBe(422)
    expect(h.upsert).not.toHaveBeenCalled()
    expect(h.audit).toHaveBeenCalledWith({ data: expect.objectContaining({ action: "ISAFLOW_CONNECT_REFUSED" }) })
    expect(everything()).not.toContain(TOKEN)
  })

  it("needs a pat_ token and an address", async () => {
    expect((await post({ action: "connect", baseUrl: "https://isaflow.example", token: "oat_x" })).status).toBe(400)
    expect((await post({ action: "connect", token: TOKEN })).status).toBe(400)
    expect((await post({ action: "nope" })).status).toBe(400)
    expect(h.probe).not.toHaveBeenCalled()
  })
})

describe("GET /api/integrations/isaflow", () => {
  it("is ADMIN's to read and never carries the token", async () => {
    h.session = caller("ADMIN", { totpVerified: false })
    h.row = { status: "CONNECTED", baseUrl: "https://isaflow.example", tokenSealed: `enc:v1:${TOKEN}`, isaflowCompanyId: "c-1", isaflowCompanyName: "Dev Co", connectedAt: new Date(), lastVerifiedAt: null }
    const res = await GET(new NextRequest("http://localhost/api/integrations/isaflow"))
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(JSON.parse(body)).toMatchObject({ status: "CONNECTED", companyName: "Dev Co" })
    expect(body).not.toContain("tokenSealed")
    expect(body).not.toContain(TOKEN)
    h.session = caller("LOAN_ADMIN")
    expect((await GET(new NextRequest("http://localhost/api/integrations/isaflow"))).status).toBe(403)
  })
})
