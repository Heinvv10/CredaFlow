import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextResponse } from "next/server"

const h = vi.hoisted(() => ({
  findUnique: vi.fn(),
  updateMany: vi.fn(),
  logCreate: vi.fn(),
}))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    apiKey: { findUnique: h.findUnique, updateMany: h.updateMany },
    apiRequestLog: { create: h.logCreate },
  },
}))

import { API_FAILED_AUTH_GLOBAL_LIMIT, API_KEY_RATE_LIMIT, withApiKey } from "./handler"
import { generateApiKey } from "./keys"
import { getCurrentTenantId } from "@/lib/tenant-scope"
import { _resetRateLimitStore } from "@/lib/rate-limit"

const key = generateApiKey()
const future = new Date(Date.now() + 86_400_000)
const row = (extra: Record<string, unknown> = {}) => ({
  id: "key-A", tenantId: "tenant-A", keyHash: key.keyHash, scopes: ["clients:read"], createdById: "user-A",
  expiresAt: future, revokedAt: null, lastUsedAt: null, tenant: { status: "ACTIVE" },
  createdBy: { active: true, role: "ADMIN" }, ...extra,
})

function call(headers: Record<string, string> = { authorization: `Bearer ${key.key}` }, scope: "clients:read" | "pii:read" = "clients:read") {
  const handler = vi.fn(async () => NextResponse.json({ tenant: getCurrentTenantId() }))
  const req = new Request("http://localhost/api/v1/clients", { headers })
  return { handler, response: withApiKey(req, scope, handler) }
}

beforeEach(() => {
  _resetRateLimitStore()
  h.findUnique.mockReset().mockResolvedValue(row())
  h.updateMany.mockReset().mockResolvedValue({ count: 1 })
  h.logCreate.mockReset().mockResolvedValue({})
})

const lastLog = () => h.logCreate.mock.calls.at(-1)![0].data

describe("withApiKey", () => {
  it("runs the handler in the key's tenant, whatever tenant header is sent, and logs the call", async () => {
    const { handler, response } = call({ authorization: `Bearer ${key.key}`, "x-tenant-slug": "tenant-B" })
    const res = await response
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ tenant: "tenant-A" })
    expect(handler).toHaveBeenCalledOnce()
    expect(h.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { prefix: key.prefix } }))
    expect(lastLog()).toMatchObject({ tenantId: "tenant-A", apiKeyId: "key-A", method: "GET", path: "/api/v1/clients", status: 200 })
    expect(res.headers.get("cache-control")).toBe("no-store")
  })

  it.each([
    ["no header", {}],
    ["a malformed key", { authorization: "Bearer not-a-key" }],
    ["another scheme", { authorization: `Basic ${key.key}` }],
  ])("refuses %s with 401, before any lookup", async (_label, headers) => {
    const { handler, response } = call(headers as Record<string, string>)
    const res = await response
    expect(res.status).toBe(401)
    expect(res.headers.get("www-authenticate")).toBe("Bearer")
    expect(h.findUnique).not.toHaveBeenCalled()
    expect(handler).not.toHaveBeenCalled()
    expect(lastLog()).toMatchObject({ tenantId: null, apiKeyId: null, status: 401 })
  })

  it("refuses an unknown prefix and a right prefix with the wrong secret, attributing neither", async () => {
    h.findUnique.mockResolvedValue(null)
    expect((await call().response).status).toBe(401)
    h.findUnique.mockResolvedValue(row({ keyHash: generateApiKey().keyHash }))
    const { handler, response } = call()
    expect((await response).status).toBe(401)
    expect(handler).not.toHaveBeenCalled()
    expect(lastLog()).toMatchObject({ tenantId: null, apiKeyId: null })
  })

  it("refuses a revoked key and an expired key", async () => {
    h.findUnique.mockResolvedValue(row({ revokedAt: new Date() }))
    let res = await call().response
    expect(res.status).toBe(401)
    expect((await res.json()).error.code).toBe("api_key_revoked")
    expect(lastLog()).toMatchObject({ tenantId: "tenant-A", apiKeyId: "key-A", status: 401 })

    h.findUnique.mockResolvedValue(row({ expiresAt: new Date(Date.now() - 1000) }))
    const { handler, response } = call()
    res = await response
    expect(res.status).toBe(401)
    expect((await res.json()).error.code).toBe("api_key_expired")
    expect(handler).not.toHaveBeenCalled()
  })

  it("refuses a key of a lender that is not ACTIVE", async () => {
    h.findUnique.mockResolvedValue(row({ tenant: { status: "SUSPENDED" } }))
    const { handler, response } = call()
    expect((await response).status).toBe(403)
    expect(handler).not.toHaveBeenCalled()
  })

  it("refuses a route whose scope the key does not hold", async () => {
    const { handler, response } = call(undefined, "pii:read")
    const res = await response
    expect(res.status).toBe(403)
    expect((await res.json()).error.code).toBe("insufficient_scope")
    expect(handler).not.toHaveBeenCalled()
  })

  it("rate limits per key", async () => {
    for (let i = 0; i < API_KEY_RATE_LIMIT.limit; i++) expect((await call().response).status).toBe(200)
    const res = await call().response
    expect(res.status).toBe(429)
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0)
  })

  it("answers 500 and still logs when the handler throws", async () => {
    const req = new Request("http://localhost/api/v1/clients", { headers: { authorization: `Bearer ${key.key}` } })
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const res = await withApiKey(req, "clients:read", async () => { throw new Error("boom") })
    expect(res.status).toBe(500)
    expect(lastLog()).toMatchObject({ status: 500, apiKeyId: "key-A" })
    err.mockRestore()
  })

  // A PrismaPromise runs only when awaited. Returned un-awaited from the
  // admin frame, the key lookup ran outside it and the tenant-scope extension
  // refused it (found by the RUN_API_IT suite). This lazy thenable records the
  // frame it actually runs in.
  it("runs the key lookup inside the admin frame, not after it", async () => {
    const { isAdminScope } = await import("@/lib/tenant-scope")
    let ranInAdminFrame: boolean | null = null
    h.findUnique.mockImplementation(() => ({
      then(resolve: (v: unknown) => void) {
        ranInAdminFrame = isAdminScope()
        resolve(row())
      },
    }))
    expect((await call().response).status).toBe(200)
    expect(ranInAdminFrame).toBe(true)
  })

  it("records lastUsedAt at most once a minute", async () => {
    await call().response
    expect(h.updateMany).toHaveBeenCalledWith({ where: { id: "key-A", tenantId: "tenant-A" }, data: { lastUsedAt: expect.any(Date) } })
    h.updateMany.mockClear()
    h.findUnique.mockResolvedValue(row({ lastUsedAt: new Date() }))
    await call().response
    expect(h.updateMany).not.toHaveBeenCalled()
  })

  it.each([
    ["deactivated", { active: false, role: "ADMIN" }],
    ["demoted below ADMIN", { active: true, role: "BRANCH_MANAGER" }],
  ])("refuses a key whose creator was %s", async (_label, createdBy) => {
    h.findUnique.mockResolvedValue(row({ createdBy }))
    const { handler, response } = call()
    const res = await response
    expect(res.status).toBe(401)
    expect((await res.json()).error.code).toBe("api_key_suspended")
    expect(handler).not.toHaveBeenCalled()
  })
})

// Review repro B1: 650 requests with junk keys made a valid key answer 429 and
// wrote 651 unauthenticated log rows.
describe("junk-key floods", () => {
  const junkKey = () => `Bearer ${generateApiKey().key}`

  beforeEach(() => {
    h.findUnique.mockImplementation(async ({ where }: { where: { prefix: string } }) => (where.prefix === key.prefix ? row() : null))
    vi.spyOn(console, "warn").mockImplementation(() => undefined)
  })

  it("never rate-limit a valid key, from an unknown address", async () => {
    for (let i = 0; i < 650; i++) await call({ authorization: junkKey() }).response
    const { handler, response } = call()
    expect((await response).status).toBe(200)
    expect(handler).toHaveBeenCalledOnce()
  })

  it("never rate-limit a valid key from another address, and throttle only the address failing", async () => {
    vi.stubEnv("TRUSTED_PROXY", "1")
    const from = (ip: string, authorization: string) => call({ authorization, "x-forwarded-for": ip })
    const statuses: number[] = []
    for (let i = 0; i < 650; i++) statuses.push((await from("203.0.113.9", junkKey()).response).status)
    expect(statuses.slice(0, 30).every((s) => s === 401)).toBe(true)
    expect(statuses.at(-1)).toBe(429)
    expect((await from("198.51.100.7", `Bearer ${key.key}`).response).status).toBe(200)
    // The failure bucket is not consulted for a valid key, even from the failing address.
    expect((await from("203.0.113.9", `Bearer ${key.key}`).response).status).toBe(200)
    vi.unstubAllEnvs()
  })

  // Review round 2 (B): with no known caller address there was no failure
  // throttle at all. A coarse global failed-auth bucket now applies; a valid
  // key never consults it.
  it("throttles failures from unknown addresses with a global bucket that valid keys never touch", async () => {
    const statuses: number[] = []
    for (let i = 0; i < API_FAILED_AUTH_GLOBAL_LIMIT.limit + 5; i++) statuses.push((await call({ authorization: junkKey() }).response).status)
    expect(statuses.slice(0, API_FAILED_AUTH_GLOBAL_LIMIT.limit).every((s) => s === 401)).toBe(true)
    expect(statuses.at(-1)).toBe(429)
    expect((await call().response).status).toBe(200)
  })

  // Review round 2 (C): 10,100 distinct addresses evicted a limited key's
  // bucket from the shared store, lifting its limit.
  it("keeps a key's rate-limit bucket however many distinct addresses fail", async () => {
    vi.stubEnv("TRUSTED_PROXY", "1")
    for (let i = 0; i <= API_KEY_RATE_LIMIT.limit; i++) await call().response
    expect((await call().response).status).toBe(429)
    for (let i = 0; i < 10_100; i++) {
      await call({ authorization: "Bearer not-a-key", "x-forwarded-for": `2001:db8:${(i >> 16).toString(16)}:${(i & 0xffff).toString(16)}::1` }).response
    }
    expect((await call().response).status).toBe(429)
    vi.unstubAllEnvs()
  }, 60_000)

  it("samples the log rows of requests that name no key", async () => {
    for (let i = 0; i < 650; i++) await call({ authorization: junkKey() }).response
    const unattributed = h.logCreate.mock.calls.filter((c) => c[0].data.apiKeyId === null)
    expect(unattributed.length).toBeLessThanOrEqual(10)
    await call().response
    expect(lastLog()).toMatchObject({ apiKeyId: "key-A", status: 200 })
  })

  it("rate limits per key, counting a refused (revoked) key's requests too, and samples its 429 rows", async () => {
    h.findUnique.mockResolvedValue(row({ revokedAt: new Date() }))
    const statuses: number[] = []
    for (let i = 0; i < 300; i++) statuses.push((await call().response).status)
    expect(statuses.filter((s) => s === 401)).toHaveLength(API_KEY_RATE_LIMIT.limit)
    expect(statuses.at(-1)).toBe(429)
    expect(h.logCreate.mock.calls.length).toBeLessThanOrEqual(API_KEY_RATE_LIMIT.limit + 10)
  })
})
