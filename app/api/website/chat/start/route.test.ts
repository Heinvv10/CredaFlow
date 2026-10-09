import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  getTenantFromRequest: vi.fn(),
  checkRateLimit: vi.fn(),
  verifyTurnstile: vi.fn(),
  logAudit: vi.fn(),
  chatBotsEnabled: vi.fn(),
  startChat: vi.fn(),
  ip: "203.0.113.9",
}))

vi.mock("@/lib/tenant", () => ({ getTenantFromRequest: mocks.getTenantFromRequest }))
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: mocks.checkRateLimit, callerIp: () => mocks.ip }))
vi.mock("@/lib/turnstile", () => ({ verifyTurnstile: mocks.verifyTurnstile }))
vi.mock("@/lib/audit", () => ({ logAudit: mocks.logAudit }))
vi.mock("@/lib/website-chat/settings", () => ({ chatBotsEnabled: mocks.chatBotsEnabled }))
vi.mock("@/lib/tenant-scope", () => ({ runWithTenant: <T>(_id: string, fn: () => T) => fn() }))
vi.mock("@/lib/config/identity", () => ({ findLenderIdentity: async () => (await import("@/lib/config/__fixtures__/lender-identity")).ACME_LENDER }))
vi.mock("@/lib/website-chat/store", () => ({ startChat: mocks.startChat }))

import { POST } from "./route"
import { verifyChatToken } from "@/lib/website-chat/token"
import type { NextRequest } from "next/server"

const VALID = { name: "Thandi Mokoena", phone: "0712345678", email: "thandi@example.test", consent: true, turnstileToken: "tok" }

function call(body: unknown = VALID) {
  return POST({ json: async () => body, headers: new Headers() } as unknown as NextRequest)
}

describe("website chat start", () => {
  const saved = { key: process.env.ANTHROPIC_API_KEY, secret: process.env.WEBSITE_CHAT_SECRET, proxy: process.env.TRUSTED_PROXY }

  beforeEach(() => {
    vi.clearAllMocks()
    process.env.ANTHROPIC_API_KEY = "test-key"
    process.env.WEBSITE_CHAT_SECRET = "s".repeat(40)
    process.env.TRUSTED_PROXY = "1"
    mocks.checkRateLimit.mockReturnValue({ allowed: true })
    mocks.verifyTurnstile.mockResolvedValue({ ok: true })
    mocks.getTenantFromRequest.mockResolvedValue({ id: "tenant-1" })
    mocks.ip = "203.0.113.9"
    mocks.chatBotsEnabled.mockResolvedValue(true)
    mocks.startChat.mockResolvedValue({ conversationId: "conv_1", leadId: "lead_1", contactId: "contact_1", matchedContactIds: [], greeting: "Hi Thandi", ref: "WC-ABC234" })
  })

  afterEach(() => {
    for (const [name, value] of [["ANTHROPIC_API_KEY", saved.key], ["WEBSITE_CHAT_SECRET", saved.secret], ["TRUSTED_PROXY", saved.proxy]] as const) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  })

  it("starts a chat, issues a verifiable token and audits the start", async () => {
    const res = await call()
    const body = (await res.json()) as { token: string; greeting: string; ref: string }

    expect(res.status).toBe(200)
    expect(verifyChatToken(body.token, new Date())).toBe("conv_1")
    expect(body.greeting).toBe("Hi Thandi")
    expect(body.ref).toBe("WC-ABC234")
    expect(Object.keys(body).sort()).toEqual(["greeting", "ref", "token"])
    expect(mocks.logAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: "WEBSITE_CHAT_STARTED",
      entity: "Conversation",
      newValue: expect.objectContaining({ leadId: "lead_1", matchedExisting: 0 }),
    }))
  })

  it("passes the tenant to startChat", async () => {
    await call()
    expect(mocks.startChat).toHaveBeenCalledWith(expect.objectContaining({ tenantId: "tenant-1", brand: "Acme Lending" }))
  })

  it("charges the per-phone+IP, per-IP and site-wide buckets only after Turnstile and validation pass", async () => {
    await call()
    expect(mocks.checkRateLimit.mock.calls).toEqual([
      ["website:chat:start:phone:27712345678:203.0.113.9", { limit: 3, windowMs: 15 * 60 * 1000 }],
      ["website:chat:start:ip:203.0.113.9", { limit: 10, windowMs: 15 * 60 * 1000 }],
      ["website:chat:start:all", { limit: 200, windowMs: 15 * 60 * 1000 }],
    ])
  })

  it("does not create a shared per-IP bucket when the IP is unknown", async () => {
    mocks.ip = "unknown"
    await call()
    const keys = mocks.checkRateLimit.mock.calls.map((c) => c[0])
    expect(keys).toEqual(["website:chat:start:phone:27712345678:unknown", "website:chat:start:all"])
  })

  it("429s on the per-IP limit without starting a chat", async () => {
    mocks.checkRateLimit.mockImplementation((key: string) => key.includes(":ip:") ? { allowed: false, retryAfterSeconds: 90 } : { allowed: true })
    const res = await call()
    expect(res.status).toBe(429)
    expect(res.headers.get("Retry-After")).toBe("90")
    expect(mocks.startChat).not.toHaveBeenCalled()
  })

  it("never charges a bucket for junk that fails Turnstile, validation or the enabled check", async () => {
    mocks.verifyTurnstile.mockResolvedValue({ ok: false })
    await call()
    mocks.verifyTurnstile.mockResolvedValue({ ok: true })
    await call({ ...VALID, consent: false })
    mocks.chatBotsEnabled.mockResolvedValue(false)
    await call()
    expect(mocks.checkRateLimit).not.toHaveBeenCalled()
  })

  it("429s on the per-phone limit without starting a chat", async () => {
    mocks.checkRateLimit.mockImplementation((key: string) => key.includes(":phone:") ? { allowed: false, retryAfterSeconds: 60 } : { allowed: true })
    const res = await call()
    expect(res.status).toBe(429)
    expect(res.headers.get("Retry-After")).toBe("60")
    expect(mocks.startChat).not.toHaveBeenCalled()
  })

  it("429s on the site-wide ceiling without starting a chat", async () => {
    mocks.checkRateLimit.mockImplementation((key: string) => key === "website:chat:start:all" ? { allowed: false, retryAfterSeconds: 30 } : { allowed: true })
    const res = await call()
    expect(res.status).toBe(429)
    expect(mocks.startChat).not.toHaveBeenCalled()
  })

  it.each([null, [], "str"])("rejects a non-object body (%j) with 400", async (bad) => {
    const res = await call(bad)
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: "Invalid request." })
    expect(mocks.startChat).not.toHaveBeenCalled()
  })

  it("rejects unparseable JSON with 400", async () => {
    const res = await POST({ json: async () => { throw new SyntaxError("bad") }, headers: new Headers() } as unknown as NextRequest)
    expect(res.status).toBe(400)
  })

  it("logs only the error message and code, never the error object", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    mocks.startChat.mockRejectedValue(Object.assign(new Error("boom Thandi 0712345678"), { code: "P2002", meta: { name: "Thandi" } }))
    const res = await call()
    expect(res.status).toBe(500)
    expect(spy.mock.calls[0][1]).toEqual({ message: "boom Thandi 0712345678", code: "P2002" })
    spy.mockRestore()
  })

  it("rejects a failed Turnstile challenge", async () => {
    mocks.verifyTurnstile.mockResolvedValue({ ok: false })
    expect((await call()).status).toBe(400)
    expect(mocks.startChat).not.toHaveBeenCalled()
  })

  it("refuses without consent", async () => {
    const res = await call({ ...VALID, consent: false })
    const body = (await res.json()) as { errors: Record<string, string> }
    expect(res.status).toBe(400)
    expect(body.errors.consent).toBeTruthy()
    expect(mocks.startChat).not.toHaveBeenCalled()
  })

  it("returns 404 when bots are disabled", async () => {
    mocks.chatBotsEnabled.mockResolvedValue(false)
    expect((await call()).status).toBe(404)
    expect(mocks.startChat).not.toHaveBeenCalled()
  })

  it("returns 404 without TRUSTED_PROXY and charges no bucket", async () => {
    delete process.env.TRUSTED_PROXY
    expect((await call()).status).toBe(404)
    expect(mocks.checkRateLimit).not.toHaveBeenCalled()
    expect(mocks.startChat).not.toHaveBeenCalled()
  })

  it("returns 404 when the API key is not configured", async () => {
    delete process.env.ANTHROPIC_API_KEY
    expect((await call()).status).toBe(404)
    expect(mocks.startChat).not.toHaveBeenCalled()
  })

  it("cleans NUL and half surrogate pairs out of the name, cell number and email before checking them, never a 500", async () => {
    const res = await call({ ...VALID, name: "Tha\u0000ndi\uD83D Mokoena", phone: "071\u00002345678", email: "a\u0000b@x.co" })
    expect(res.status).toBe(200)
    expect(mocks.startChat).toHaveBeenCalledWith(expect.objectContaining({
      fields: { firstName: "Thandi", lastName: "Mokoena", phone: "27712345678", email: "ab@x.co" },
    }))
  })

  it("a field that is only unstorable characters is the usual 400 for that field", async () => {
    const res = await call({ ...VALID, email: "\u0000\uDE00" })
    expect(res.status).toBe(400)
    expect((await res.json()).errors).toEqual({ email: "Please enter a valid email address." })
    expect(mocks.startChat).not.toHaveBeenCalled()
  })
})
