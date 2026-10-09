import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  getTenantFromRequest: vi.fn(),
  checkRateLimit: vi.fn(),
  chatBotsEnabled: vi.fn(),
  loadChat: vi.fn(),
  expireHandoffIfDue: vi.fn(),
}))

vi.mock("@/lib/tenant", () => ({ getTenantFromRequest: mocks.getTenantFromRequest }))
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: mocks.checkRateLimit, callerIp: () => "203.0.113.9" }))
vi.mock("@/lib/website-chat/settings", () => ({ chatBotsEnabled: mocks.chatBotsEnabled }))
vi.mock("@/lib/tenant-scope", () => ({ runWithTenant: <T>(_id: string, fn: () => T) => fn() }))
vi.mock("@/lib/website-chat/store", () => ({ loadChat: mocks.loadChat }))
vi.mock("@/lib/website-chat/handoff", () => ({ expireHandoffIfDue: mocks.expireHandoffIfDue }))

import { POST } from "./route"
import { issueChatToken } from "@/lib/website-chat/token"
import type { NextRequest } from "next/server"

function call(body: unknown) {
  return POST({ json: async () => body, headers: new Headers() } as unknown as NextRequest)
}

const LINES = [
  { id: "m1", from: "visitor", text: "Hello" },
  { id: "m2", from: "assistant", text: "Hi" },
  { id: "m3", from: "staff", text: "Thandi here" },
]
const CHAT = { id: "conv_1", closed: false, handedOff: true, mode: "staff", staffFirstName: "Thandi", ref: "CH-1", turns: [], lines: LINES }

describe("website chat poll", () => {
  const saved = { key: process.env.ANTHROPIC_API_KEY, secret: process.env.WEBSITE_CHAT_SECRET, proxy: process.env.TRUSTED_PROXY }
  let token: string

  beforeEach(() => {
    vi.clearAllMocks()
    process.env.ANTHROPIC_API_KEY = "test-key"
    process.env.WEBSITE_CHAT_SECRET = "s".repeat(40)
    process.env.TRUSTED_PROXY = "1"
    token = issueChatToken("conv_1", new Date())
    mocks.checkRateLimit.mockReturnValue({ allowed: true })
    mocks.getTenantFromRequest.mockResolvedValue({ id: "tenant-1" })
    mocks.chatBotsEnabled.mockResolvedValue(true)
    mocks.loadChat.mockResolvedValue({ ...CHAT })
    mocks.expireHandoffIfDue.mockResolvedValue(false)
  })

  afterEach(() => {
    for (const [name, value] of [["ANTHROPIC_API_KEY", saved.key], ["WEBSITE_CHAT_SECRET", saved.secret], ["TRUSTED_PROXY", saved.proxy]] as const) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  })

  it("404s when the chat is not configured, bots are off, or there is no tenant", async () => {
    delete process.env.ANTHROPIC_API_KEY
    expect((await call({ token })).status).toBe(404)
    process.env.ANTHROPIC_API_KEY = "test-key"
    mocks.chatBotsEnabled.mockResolvedValue(false)
    expect((await call({ token })).status).toBe(404)
    mocks.chatBotsEnabled.mockResolvedValue(true)
    mocks.getTenantFromRequest.mockResolvedValue(null)
    expect((await call({ token })).status).toBe(404)
    expect(mocks.loadChat).not.toHaveBeenCalled()
  })

  it("401s a bad token and charges the per-IP bad-token bucket", async () => {
    const res = await call({ token: "garbage" })
    expect(res.status).toBe(401)
    expect(mocks.checkRateLimit).toHaveBeenCalledWith("website:chat:badtoken:203.0.113.9", { limit: 30, windowMs: 10 * 60 * 1000 })
    expect(mocks.loadChat).not.toHaveBeenCalled()
  })

  it("429s a guessing IP once the bad-token bucket is spent", async () => {
    mocks.checkRateLimit.mockReturnValue({ allowed: false, retryAfterSeconds: 77 })
    const res = await call({ token: "garbage" })
    expect(res.status).toBe(429)
    expect(res.headers.get("Retry-After")).toBe("77")
  })

  it("returns mode, staff name, ref and exactly the lines the store gave (no internal notes)", async () => {
    const res = await call({ token })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ mode: "staff", staffName: "Thandi", ref: "CH-1", lines: LINES })
    expect(mocks.loadChat).toHaveBeenCalledWith("tenant-1", "conv_1")
    expect(mocks.expireHandoffIfDue).not.toHaveBeenCalled()
  })

  it("returns mode ended with 200 for a closed chat", async () => {
    mocks.loadChat.mockResolvedValue({ ...CHAT, closed: true, mode: "ended", staffFirstName: null })
    const res = await call({ token })
    expect(res.status).toBe(200)
    expect((await res.json()).mode).toBe("ended")
  })

  it("expires a due wait and answers fallback in the same response", async () => {
    mocks.loadChat.mockResolvedValue({ ...CHAT, mode: "waiting", staffFirstName: null })
    mocks.expireHandoffIfDue.mockResolvedValue(true)
    const res = await call({ token })
    expect(mocks.expireHandoffIfDue).toHaveBeenCalledWith({ tenantId: "tenant-1", conversationId: "conv_1", now: expect.any(Date) })
    expect(await res.json()).toMatchObject({ mode: "fallback", staffName: null, ref: "CH-1" })
  })

  it("re-reads a waiting chat that was not expired, so a staffer who joined is reported", async () => {
    mocks.loadChat
      .mockResolvedValueOnce({ ...CHAT, mode: "waiting", staffFirstName: null })
      .mockResolvedValueOnce({ ...CHAT })
    const res = await call({ token })
    expect(mocks.loadChat).toHaveBeenCalledTimes(2)
    expect(await res.json()).toMatchObject({ mode: "staff", staffName: "Thandi" })
  })

  it("keeps waiting when the wait is not due", async () => {
    mocks.loadChat.mockResolvedValue({ ...CHAT, mode: "waiting", staffFirstName: null })
    const res = await call({ token })
    expect(await res.json()).toMatchObject({ mode: "waiting", staffName: null })
  })

  it("rate limits per conversation at 40 a minute with Retry-After", async () => {
    mocks.checkRateLimit.mockReturnValue({ allowed: false, retryAfterSeconds: 12 })
    const res = await call({ token })
    expect(mocks.checkRateLimit).toHaveBeenCalledWith("website:chat:poll:conv_1", { limit: 40, windowMs: 60_000 })
    expect(res.status).toBe(429)
    expect(res.headers.get("Retry-After")).toBe("12")
    expect(mocks.loadChat).not.toHaveBeenCalled()
  })

  it("401s a token whose conversation is not in this tenant", async () => {
    mocks.loadChat.mockResolvedValue(null)
    const res = await call({ token })
    expect(res.status).toBe(401)
    expect(mocks.loadChat).toHaveBeenCalledWith("tenant-1", "conv_1")
  })

  it("500s without leaking the error", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    mocks.loadChat.mockRejectedValue(new Error("db down: secret"))
    const res = await call({ token })
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain("secret")
  })
})
