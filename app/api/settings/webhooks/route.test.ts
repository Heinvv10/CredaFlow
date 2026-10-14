import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import { randomBytes } from "node:crypto"

const h = vi.hoisted(() => ({
  session: null as null | { user: Record<string, unknown> },
  count: vi.fn(),
  create: vi.fn(),
  audit: vi.fn(),
}))

vi.mock("next/navigation", () => ({ redirect: vi.fn() }))
vi.mock("@/lib/auth", () => ({ auth: async () => h.session }))
vi.mock("@/lib/tenant", () => ({ withTenantContext: (_req: unknown, fn: (t: { id: string }) => Promise<Response>) => fn({ id: "t1" }) }))
vi.mock("node:dns/promises", () => ({
  lookup: async (host: string) => (host === "internal.example.com" ? [{ address: "10.0.0.7", family: 4 }] : [{ address: "93.184.215.14", family: 4 }]),
}))
vi.mock("@/lib/prisma", () => {
  const tx = { webhookEndpoint: { count: h.count, create: h.create }, auditLog: { create: h.audit } }
  return { prisma: { $transaction: async (fn: (t: typeof tx) => unknown) => fn(tx) } }
})

import { POST } from "./route"
import { openSecret } from "@/lib/crypto/secret-box"

const key = randomBytes(32).toString("base64")
const admin = { user: { id: "admin-1", email: "admin@lender.example", role: "ADMIN", tenantId: "t1", totpVerified: true } }
const post = (body: unknown) => POST(new NextRequest("http://localhost/api/settings/webhooks", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
}))
const valid = { url: "https://hooks.example.com/cf", events: ["loan.disbursed", "payment.received"] }

beforeEach(() => {
  vi.stubEnv("WEBHOOK_SECRET_KEY", key)
  h.session = admin
  h.count.mockReset().mockResolvedValue(0)
  h.create.mockReset().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: "ep-1", url: data.url, events: data.events, secretPrefix: data.secretPrefix,
  }))
  h.audit.mockReset().mockResolvedValue({})
})
afterEach(() => vi.unstubAllEnvs())

describe("POST /api/settings/webhooks", () => {
  it("adds the endpoint with a sealed secret, returns the secret once, and audits without it", async () => {
    const res = await post(valid)
    expect(res.status).toBe(201)
    const { secret } = await res.json()
    const stored = h.create.mock.calls[0][0].data
    expect(stored).toMatchObject({ tenantId: "t1", url: "https://hooks.example.com/cf", createdById: "admin-1" })
    expect(stored.secretSealed).not.toContain(secret)
    expect(openSecret(stored.secretSealed, key)).toBe(secret)
    expect(JSON.stringify(h.audit.mock.calls[0][0].data)).not.toContain(secret)
    expect(h.audit.mock.calls[0][0].data.action).toBe("WEBHOOK_ENDPOINT_CREATED")
  })

  it.each([
    ["http://hooks.example.com/cf", /https/],
    ["https://127.0.0.1/cf", /not a public address/],
    ["https://internal.example.com/cf", /10\.0\.0\.7/],
  ])("refuses %s (SSRF guard)", async (url, message) => {
    const res = await post({ ...valid, url })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(message)
    expect(h.create).not.toHaveBeenCalled()
  })

  it("refuses unknown events, and works only when the server has a sealing key", async () => {
    expect((await post({ ...valid, events: ["loan.created"] })).status).toBe(400)
    vi.stubEnv("WEBHOOK_SECRET_KEY", "")
    expect((await post(valid)).status).toBe(503)
    expect(h.create).not.toHaveBeenCalled()
  })

  it("needs ADMIN with 2FA", async () => {
    h.session = { user: { ...admin.user, totpVerified: false } }
    expect((await post(valid)).status).toBe(403)
    h.session = { user: { ...admin.user, role: "LOAN_ADMIN" } }
    expect((await post(valid)).status).toBe(403)
    expect(h.create).not.toHaveBeenCalled()
  })
})
