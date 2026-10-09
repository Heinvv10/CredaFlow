import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  getTenantFromRequest: vi.fn(),
  checkRateLimit: vi.fn(),
  logAudit: vi.fn(),
  chatBotsEnabled: vi.fn(),
  loadChat: vi.fn(),
  recordVisitorMessage: vi.fn(),
  recordVisitorMessageToStaff: vi.fn(),
  recordAssistantReply: vi.fn(),
  notifyStaffOfHandoff: vi.fn(),
  askAssistant: vi.fn(),
  order: [] as string[],
}))

vi.mock("@/lib/tenant", () => ({ getTenantFromRequest: mocks.getTenantFromRequest }))
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: mocks.checkRateLimit, callerIp: () => "203.0.113.9" }))
vi.mock("@/lib/audit", () => ({ logAudit: mocks.logAudit }))
vi.mock("@/lib/website-chat/settings", () => ({ chatBotsEnabled: mocks.chatBotsEnabled }))
vi.mock("@/lib/tenant-scope", () => ({ runWithTenant: <T>(_id: string, fn: () => T) => fn() }))
vi.mock("@/lib/config/identity", () => ({ findLenderIdentity: async () => (await import("@/lib/config/__fixtures__/lender-identity")).ACME_LENDER }))
vi.mock("@/lib/website-chat/knowledge", () => ({ knowledgeFor: async () => "KNOWLEDGE" }))
vi.mock("@/lib/website-chat/store", () => ({
  loadChat: mocks.loadChat,
  recordVisitorMessage: mocks.recordVisitorMessage,
  recordVisitorMessageToStaff: mocks.recordVisitorMessageToStaff,
  recordAssistantReply: mocks.recordAssistantReply,
}))
vi.mock("@/lib/website-chat/handoff", () => ({ notifyStaffOfHandoff: mocks.notifyStaffOfHandoff }))
vi.mock("@/lib/website-chat/model", () => ({ askAssistant: mocks.askAssistant }))

import { POST } from "./route"
import { issueChatToken } from "@/lib/website-chat/token"
import type { NextRequest } from "next/server"

function call(body: unknown) {
  return POST({ json: async () => body, headers: new Headers() } as unknown as NextRequest)
}

// What the store says it wrote for a hand-off: the store writes the line (with reply "" from the route), not the route.
const LINE = "I can't help with that here, so I'll connect you to a consultant."
const AWAY = "Our consultants aren't available right now. They're available Monday to Friday, 08:00 to 17:00."
const CHAT = { id: "conv_1", closed: false, handedOff: false, mode: "bot", staffFirstName: null, turns: [{ role: "assistant", text: "Hi" }] }

describe("website chat message", () => {
  const saved = { key: process.env.ANTHROPIC_API_KEY, secret: process.env.WEBSITE_CHAT_SECRET, proxy: process.env.TRUSTED_PROXY }
  let token: string

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.order.length = 0
    process.env.ANTHROPIC_API_KEY = "test-key"
    process.env.WEBSITE_CHAT_SECRET = "s".repeat(40)
    process.env.TRUSTED_PROXY = "1"
    token = issueChatToken("conv_1", new Date())
    mocks.checkRateLimit.mockReturnValue({ allowed: true })
    mocks.getTenantFromRequest.mockResolvedValue({ id: "tenant-1" })
    mocks.chatBotsEnabled.mockResolvedValue(true)
    mocks.loadChat.mockResolvedValue({ ...CHAT })
    mocks.recordVisitorMessage.mockImplementation(async () => { mocks.order.push("record"); return { accepted: true } })
    mocks.askAssistant.mockImplementation(async () => {
      mocks.order.push("ask")
      return { reply: "08:00 to 17:00.", needsHuman: false, reason: null }
    })
    mocks.recordAssistantReply.mockImplementation(async (a: { reply: string }) => ({ handedOffNow: false, suppressed: false, reply: a.reply }))
    mocks.recordVisitorMessageToStaff.mockResolvedValue({ accepted: true })
    mocks.notifyStaffOfHandoff.mockResolvedValue(undefined)
  })

  afterEach(() => {
    for (const [name, value] of [["ANTHROPIC_API_KEY", saved.key], ["WEBSITE_CHAT_SECRET", saved.secret], ["TRUSTED_PROXY", saved.proxy]] as const) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  })

  it("records the visitor message, asks the model, and records the reply", async () => {
    const res = await call({ token, text: "  What are your hours?  " })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ reply: "08:00 to 17:00.", handedOff: false, mode: "bot" })
    expect(mocks.notifyStaffOfHandoff).not.toHaveBeenCalled()
    expect(mocks.order).toEqual(["record", "ask"])
    expect(mocks.askAssistant.mock.calls[0][1]).toEqual([
      { role: "assistant", text: "Hi" },
      { role: "visitor", text: "What are your hours?" },
    ])
    expect(mocks.recordAssistantReply).toHaveBeenCalledWith(expect.objectContaining({ reply: "08:00 to 17:00.", needsHuman: false, reason: null }))
  })

  it("builds the system prompt from the tenant's own brand and knowledge", async () => {
    await call({ token, text: "hi" })
    const system = mocks.askAssistant.mock.calls[0][0] as string
    expect(system).toContain("Acme Lending")
    expect(system).toContain("KNOWLEDGE")
  })

  it("passes the tenant to every store call", async () => {
    await call({ token, text: "hi" })
    expect(mocks.loadChat).toHaveBeenCalledWith("tenant-1", "conv_1")
    expect(mocks.recordVisitorMessage).toHaveBeenCalledWith(expect.objectContaining({ tenantId: "tenant-1" }))
    expect(mocks.recordAssistantReply).toHaveBeenCalledWith(expect.objectContaining({ tenantId: "tenant-1" }))
  })

  it("does not audit when no hand-off happened now", async () => {
    await call({ token, text: "hi" })
    expect(mocks.logAudit).not.toHaveBeenCalled()
  })

  it("stores and audits the hand-off reason code, never model free text", async () => {
    mocks.askAssistant.mockResolvedValue({ needsHuman: true, reason: "account_question", reply: "ok" })
    mocks.recordAssistantReply.mockResolvedValue({ handedOffNow: true, suppressed: false, mode: "waiting", reply: LINE })
    await call({ token, text: "call me" })
    expect(mocks.recordAssistantReply.mock.calls[0][0].reason).toBe("account_question")
    expect(mocks.logAudit.mock.calls[0][0].newValue).toEqual({ reason: "account_question" })
  })

  it("charges only the per-conversation bucket for a valid token", async () => {
    await call({ token, text: "hi" })
    expect(mocks.checkRateLimit).toHaveBeenCalledTimes(1)
    expect(mocks.checkRateLimit).toHaveBeenCalledWith("website:chat:msg:conv_1", { limit: 30, windowMs: 10 * 60 * 1000 })
  })

  it("429s when the conversation bucket is exhausted", async () => {
    mocks.checkRateLimit.mockReturnValue({ allowed: false, retryAfterSeconds: 12 })
    const res = await call({ token, text: "hi" })
    expect(res.status).toBe(429)
    expect(mocks.recordVisitorMessage).not.toHaveBeenCalled()
  })

  it("charges the bad-token bucket on a bad token and 401s while it has room", async () => {
    const res = await call({ token: "junk", text: "hi" })
    expect(res.status).toBe(401)
    expect(mocks.checkRateLimit).toHaveBeenCalledTimes(1)
    expect(mocks.checkRateLimit).toHaveBeenCalledWith("website:chat:badtoken:203.0.113.9", { limit: 30, windowMs: 10 * 60 * 1000 })
  })

  it("429s a bad token once the bad-token bucket is exhausted", async () => {
    mocks.checkRateLimit.mockReturnValue({ allowed: false, retryAfterSeconds: 5 })
    expect((await call({ token: "junk", text: "hi" })).status).toBe(429)
  })

  it("401s an expired token", async () => {
    const old = issueChatToken("conv_1", new Date(Date.now() - 3 * 60 * 60 * 1000))
    expect((await call({ token: old, text: "hi" })).status).toBe(401)
    expect(mocks.loadChat).not.toHaveBeenCalled()
  })

  it.each([null, [], "str"])("rejects a non-object body (%j) with 400 and charges nothing", async (bad) => {
    const res = await call(bad)
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: "Invalid request." })
    expect(mocks.checkRateLimit).not.toHaveBeenCalled()
  })

  it("rejects unparseable JSON with 400", async () => {
    const res = await POST({ json: async () => { throw new SyntaxError("bad") }, headers: new Headers() } as unknown as NextRequest)
    expect(res.status).toBe(400)
  })

  it("logs only the error message and code, never the error object", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    mocks.loadChat.mockRejectedValue(Object.assign(new Error("boom"), { code: "P1001", meta: { phone: "0712345678" } }))
    expect((await call({ token, text: "hi" })).status).toBe(500)
    expect(spy.mock.calls[0][1]).toEqual({ message: "boom", code: "P1001" })
    spy.mockRestore()
  })

  it("flags a hand-off and audits it", async () => {
    mocks.askAssistant.mockResolvedValue({ needsHuman: true, reason: "x", reply: "…" })
    mocks.recordAssistantReply.mockResolvedValue({ handedOffNow: true, suppressed: false, mode: "waiting", reply: LINE })

    const body = (await (await call({ token, text: "call me" })).json()) as { handedOff: boolean }

    expect(body.handedOff).toBe(true)
    expect(mocks.logAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "WEBSITE_CHAT_HANDOFF", entityId: "conv_1" }))
  })

  it("rejects a forged token and records nothing", async () => {
    const res = await call({ token: "conv_1.9999999999999.bad", text: "hi" })
    expect(res.status).toBe(401)
    expect(mocks.loadChat).not.toHaveBeenCalled()
    expect(mocks.recordVisitorMessage).not.toHaveBeenCalled()
  })

  it("returns 401 when the conversation does not exist", async () => {
    mocks.loadChat.mockResolvedValue(null)
    expect((await call({ token, text: "hi" })).status).toBe(401)
    expect(mocks.recordVisitorMessage).not.toHaveBeenCalled()
  })

  it("returns 409 for a closed chat and records nothing", async () => {
    mocks.loadChat.mockResolvedValue({ ...CHAT, closed: true })
    const res = await call({ token, text: "hi" })
    const body = (await res.json()) as { error: string }
    expect(res.status).toBe(409)
    expect(body.error).toContain("ended")
    expect(mocks.recordVisitorMessage).not.toHaveBeenCalled()
  })

  it("returns the same 409 when the chat was closed after the read, and neither asks the model nor hands off", async () => {
    mocks.loadChat.mockResolvedValue({ ...CHAT, closed: true })
    const closedAtRead = await call({ token, text: "hi" })
    mocks.loadChat.mockResolvedValue({ ...CHAT })
    mocks.recordVisitorMessage.mockResolvedValue({ accepted: false, reason: "closed" })
    const res = await call({ token, text: "hi" })
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual(await closedAtRead.json())
    expect(mocks.askAssistant).not.toHaveBeenCalled()
    expect(mocks.recordAssistantReply).not.toHaveBeenCalled()
    expect(mocks.notifyStaffOfHandoff).not.toHaveBeenCalled()
    expect(mocks.logAudit).not.toHaveBeenCalled()
  })

  it("rejects empty and oversized text", async () => {
    expect((await call({ token, text: "x".repeat(1001) })).status).toBe(400)
    expect((await call({ token, text: "   " })).status).toBe(400)
    expect(mocks.recordVisitorMessage).not.toHaveBeenCalled()
  })

  it.each([
    ["half a surrogate pair", "hi \uD83D there", "hi  there"],
    ["a NUL", "a\u0000b", "ab"],
    ["a whole emoji, kept", "ok \uD83D\uDE00", "ok \uD83D\uDE00"],
  ])("stores and sends the model clean text for a message with %s", async (_name, sent, clean) => {
    const res = await call({ token, text: sent })
    expect(res.status).toBe(200)
    expect(mocks.recordVisitorMessage).toHaveBeenCalledWith(expect.objectContaining({ text: clean }))
    expect(mocks.askAssistant.mock.calls[0][1].at(-1)).toEqual({ role: "visitor", text: clean })
  })

  it("rejects a message that is empty once cleaned, with the usual 400", async () => {
    const res = await call({ token, text: " \u0000\uD83D " })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: "Please keep messages between 1 and 1000 characters." })
    expect(mocks.recordVisitorMessage).not.toHaveBeenCalled()
  })

  it("when the chat's cap refuses the message, hands off once, never calls the model and writes nothing else", async () => {
    mocks.recordVisitorMessage.mockResolvedValue({ accepted: false, reason: "conversation_cap", stored: true })
    mocks.recordAssistantReply.mockResolvedValue({ handedOffNow: true, suppressed: false, mode: "waiting", reply: LINE })
    const res = await call({ token, text: "more" })
    expect(res.status).toBe(429)
    expect(await res.json()).toEqual({ reply: LINE, handedOff: true, mode: "waiting" })
    expect(mocks.notifyStaffOfHandoff).toHaveBeenCalledOnce()
    expect(mocks.askAssistant).not.toHaveBeenCalled()
    expect(mocks.recordAssistantReply).toHaveBeenCalledOnce()
    expect(mocks.recordAssistantReply).toHaveBeenCalledWith(expect.objectContaining({ tenantId: "tenant-1", reply: "", needsHuman: true, reason: "message_limit" }))
    expect(mocks.logAudit).toHaveBeenCalledOnce()
    expect(mocks.logAudit.mock.calls[0][0]).toMatchObject({ action: "WEBSITE_CHAT_HANDOFF", newValue: { reason: "message_limit" } })
  })

  it("a message refused for a cap that the staff-mode cap refuses too: the hand-off still opens, and the visitor is told the limit", async () => {
    mocks.recordVisitorMessage.mockResolvedValue({ accepted: false, reason: "conversation_cap", stored: false })
    mocks.recordAssistantReply.mockResolvedValue({ handedOffNow: true, suppressed: false, mode: "waiting", reply: LINE })
    mocks.loadChat.mockResolvedValueOnce({ ...CHAT }).mockResolvedValueOnce({ ...CHAT, handedOff: true, mode: "waiting" })
    const res = await call({ token, text: "more" })
    expect(res.status).toBe(429)
    expect(await res.json()).toEqual({ mode: "waiting", error: "You've reached the message limit for this chat. The consultant can still reply." })
    expect(mocks.recordAssistantReply).toHaveBeenCalledWith(expect.objectContaining({ handoffOnly: true }))
    expect(mocks.notifyStaffOfHandoff).toHaveBeenCalledOnce()
  })

  it.each(["conversation_cap", "daily_cap"])("when %s refuses a message and another call opened the hand-off, no reply and nothing further", async (reason) => {
    mocks.loadChat.mockResolvedValue({ ...CHAT, handedOff: true, mode: "fallback" })
    mocks.recordVisitorMessage.mockResolvedValue({ accepted: false, reason, stored: true })
    // The store writes the hand-off reply only for the call that opens the hand-off.
    mocks.recordAssistantReply.mockResolvedValue({ handedOffNow: false, suppressed: true })
    const res = await call({ token, text: "more" })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ mode: "fallback", staffName: null })
    expect(mocks.recordAssistantReply).toHaveBeenCalledWith(expect.objectContaining({ reply: "", needsHuman: true, handoffOnly: true }))
    expect(mocks.notifyStaffOfHandoff).not.toHaveBeenCalled()
    expect(mocks.askAssistant).not.toHaveBeenCalled()
    expect(mocks.logAudit).not.toHaveBeenCalled()
  })

  it("when the tenant's daily cap refuses the message, never calls the model and hands off once with daily_limit", async () => {
    mocks.recordVisitorMessage.mockResolvedValue({ accepted: false, reason: "daily_cap", stored: true })
    mocks.recordAssistantReply.mockResolvedValue({ handedOffNow: true, suppressed: false, mode: "fallback", reply: AWAY })
    const res = await call({ token, text: "hi" })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ reply: AWAY, handedOff: true, mode: "fallback" })
    expect(mocks.notifyStaffOfHandoff).toHaveBeenCalledOnce()
    expect(mocks.askAssistant).not.toHaveBeenCalled()
    expect(mocks.recordAssistantReply).toHaveBeenCalledOnce()
    expect(mocks.recordAssistantReply).toHaveBeenCalledWith(expect.objectContaining({ reply: "", needsHuman: true, reason: "daily_limit" }))
    expect(mocks.logAudit.mock.calls[0][0].newValue).toEqual({ reason: "daily_limit" })
  })

  it("returns 404 without TRUSTED_PROXY and records nothing", async () => {
    delete process.env.TRUSTED_PROXY
    expect((await call({ token, text: "hi" })).status).toBe(404)
    expect(mocks.loadChat).not.toHaveBeenCalled()
    expect(mocks.recordVisitorMessage).not.toHaveBeenCalled()
  })

  it("returns 404 when bots are disabled", async () => {
    mocks.chatBotsEnabled.mockResolvedValue(false)
    expect((await call({ token, text: "hi" })).status).toBe(404)
    expect(mocks.loadChat).not.toHaveBeenCalled()
  })
})
