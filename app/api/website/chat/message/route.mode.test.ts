import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// The mode-aware half of the message route; route.test.ts holds the rest.
const mocks = vi.hoisted(() => ({
  logAudit: vi.fn(),
  loadChat: vi.fn(),
  recordVisitorMessage: vi.fn(),
  recordVisitorMessageToStaff: vi.fn(),
  recordAssistantReply: vi.fn(),
  notifyStaffOfHandoff: vi.fn(),
  askAssistant: vi.fn(),
}))

vi.mock("@/lib/tenant", () => ({ getTenantFromRequest: async () => ({ id: "tenant-1" }) }))
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: () => ({ allowed: true }), callerIp: () => "203.0.113.9" }))
vi.mock("@/lib/audit", () => ({ logAudit: mocks.logAudit }))
vi.mock("@/lib/website-chat/settings", () => ({ chatBotsEnabled: async () => true }))
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

const STORED = "I'll ask a consultant.\n\nI can't help with that here, so I'll connect you to a consultant."
const LIMIT = "You've reached the message limit for this chat. The consultant can still reply."
const CHAT = { id: "conv_1", closed: false, handedOff: false, mode: "bot", staffFirstName: null, turns: [{ role: "assistant", text: "Hi" }] }

describe("website chat message: mode", () => {
  const saved = { key: process.env.ANTHROPIC_API_KEY, secret: process.env.WEBSITE_CHAT_SECRET, proxy: process.env.TRUSTED_PROXY }
  let token: string

  beforeEach(() => {
    vi.clearAllMocks()
    process.env.ANTHROPIC_API_KEY = "test-key"
    process.env.WEBSITE_CHAT_SECRET = "s".repeat(40)
    process.env.TRUSTED_PROXY = "1"
    token = issueChatToken("conv_1", new Date())
    mocks.loadChat.mockResolvedValue({ ...CHAT })
    mocks.recordVisitorMessage.mockResolvedValue({ accepted: true })
    mocks.recordVisitorMessageToStaff.mockResolvedValue({ accepted: true })
    mocks.askAssistant.mockResolvedValue({ reply: "08:00 to 17:00.", needsHuman: false, reason: null })
    // The store writes the reply and says what it wrote: a plain answer as the model gave it.
    mocks.recordAssistantReply.mockImplementation(async (a: { reply: string }) => ({ handedOffNow: false, suppressed: false, reply: a.reply }))
    mocks.notifyStaffOfHandoff.mockResolvedValue(undefined)
  })

  afterEach(() => {
    for (const [name, value] of [["ANTHROPIC_API_KEY", saved.key], ["WEBSITE_CHAT_SECRET", saved.secret], ["TRUSTED_PROXY", saved.proxy]] as const) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  })

  const handOffNow = () => {
    mocks.askAssistant.mockResolvedValue({ needsHuman: true, reason: "account_question", reply: "I'll ask a consultant." })
    mocks.recordAssistantReply.mockResolvedValue({ handedOffNow: true, suppressed: false, mode: "waiting", reply: STORED })
  }

  it.each([
    ["waiting", null],
    ["staff", "Thandi"],
  ])("in %s mode stores the message for staff and never reaches the model", async (mode, staffFirstName) => {
    mocks.loadChat.mockResolvedValue({ ...CHAT, handedOff: mode === "waiting", mode, staffFirstName })
    const res = await call({ token, text: "  Are you there?  " })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ mode, staffName: staffFirstName })
    expect(mocks.recordVisitorMessageToStaff).toHaveBeenCalledOnce()
    expect(mocks.recordVisitorMessageToStaff).toHaveBeenCalledWith(expect.objectContaining({ tenantId: "tenant-1", conversationId: "conv_1", text: "Are you there?" }))
    expect(mocks.askAssistant).not.toHaveBeenCalled()
    expect(mocks.recordVisitorMessage).not.toHaveBeenCalled()
    expect(mocks.recordAssistantReply).not.toHaveBeenCalled()
    expect(mocks.notifyStaffOfHandoff).not.toHaveBeenCalled()
  })

  it.each(["waiting", "staff"])("in %s mode a message past the staff-mode cap is a 429 with the limit notice; the chat goes on", async (mode) => {
    mocks.loadChat.mockResolvedValue({ ...CHAT, mode, staffFirstName: mode === "staff" ? "Thandi" : null })
    mocks.recordVisitorMessageToStaff.mockResolvedValue({ accepted: false, reason: "staff_cap" })
    const res = await call({ token, text: "hello?" })
    expect(res.status).toBe(429)
    expect(await res.json()).toEqual({ mode, error: LIMIT })
    expect(mocks.askAssistant).not.toHaveBeenCalled()
    expect(mocks.recordVisitorMessage).not.toHaveBeenCalled()
  })

  it("in the fallback the staff-mode limit points the visitor to WhatsApp and the call-back", async () => {
    mocks.loadChat.mockResolvedValueOnce({ ...CHAT }).mockResolvedValueOnce({ ...CHAT, handedOff: true, mode: "fallback" })
    mocks.recordVisitorMessage.mockResolvedValue({ accepted: false, reason: "to_staff", stored: false })
    const res = await call({ token, text: "hello?" })
    expect(res.status).toBe(429)
    expect(await res.json()).toEqual({ mode: "fallback", error: "You've reached the message limit for this chat. Please use the WhatsApp button or wait for our call." })
  })

  it("a message for staff on a chat closed meanwhile is the usual 409 ended", async () => {
    mocks.loadChat.mockResolvedValue({ ...CHAT, mode: "staff", staffFirstName: "Thandi" })
    mocks.recordVisitorMessageToStaff.mockResolvedValue({ accepted: false, reason: "closed" })
    const res = await call({ token, text: "hello?" })
    expect(res.status).toBe(409)
    expect((await res.json()).error).toContain("ended")
  })

  it("a message for staff on a chat they handed back meanwhile is taken by the assistant, with the chat read again", async () => {
    mocks.loadChat.mockResolvedValueOnce({ ...CHAT, mode: "staff", staffFirstName: "Thandi" }).mockResolvedValueOnce({ ...CHAT })
    mocks.recordVisitorMessageToStaff.mockResolvedValue({ accepted: false, reason: "not_staff" })
    const res = await call({ token, text: "What are your hours?" })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ reply: "08:00 to 17:00.", handedOff: false, mode: "bot" })
    expect(mocks.loadChat).toHaveBeenCalledTimes(2)
    expect(mocks.recordVisitorMessage).toHaveBeenCalledOnce()
    expect(mocks.askAssistant).toHaveBeenCalledOnce()
  })

  it("in fallback mode the bot keeps answering and no new hand-off starts", async () => {
    mocks.loadChat.mockResolvedValue({ ...CHAT, handedOff: true, mode: "fallback" })
    const res = await call({ token, text: "What are your hours?" })
    expect(await res.json()).toEqual({ reply: "08:00 to 17:00.", handedOff: true, mode: "fallback" })
    expect(mocks.recordVisitorMessage).toHaveBeenCalledOnce()
    expect(mocks.recordVisitorMessageToStaff).not.toHaveBeenCalled()
    expect(mocks.notifyStaffOfHandoff).not.toHaveBeenCalled()
  })

  it.each(["waiting", "fallback"])("on the request that hands off, rings staff once and returns the mode the store opened (%s)", async (mode) => {
    handOffNow()
    mocks.recordAssistantReply.mockResolvedValue({ handedOffNow: true, suppressed: false, mode, reply: STORED })
    const res = await call({ token, text: "Do I owe you money?" })
    expect(res.status).toBe(200)
    // What the store wrote (the model's text plus the hand-off line), not the model's text alone.
    expect(await res.json()).toEqual({ reply: STORED, handedOff: true, mode })
    expect(mocks.notifyStaffOfHandoff).toHaveBeenCalledOnce()
    expect(mocks.notifyStaffOfHandoff).toHaveBeenCalledWith({ tenantId: "tenant-1", conversationId: "conv_1", now: expect.any(Date) })
  })

  it.each(["waiting", "fallback", "staff"])("a hand-off another request won is not started again; the mode is re-read (%s)", async (mode) => {
    mocks.askAssistant.mockResolvedValue({ needsHuman: true, reason: "complaint", reply: "ok" })
    mocks.loadChat.mockResolvedValueOnce({ ...CHAT }).mockResolvedValueOnce({ ...CHAT, handedOff: true, mode })
    const res = await call({ token, text: "call me" })
    expect(await res.json()).toEqual({ reply: "ok", handedOff: true, mode })
    expect(mocks.loadChat).toHaveBeenCalledTimes(2)
    expect(mocks.loadChat).toHaveBeenLastCalledWith("tenant-1", "conv_1")
    expect(mocks.notifyStaffOfHandoff).not.toHaveBeenCalled()
  })

  it("a cap hand-off another request won is not started again: no reply, the mode is re-read", async () => {
    mocks.recordVisitorMessage.mockResolvedValue({ accepted: false, reason: "daily_cap", stored: true })
    mocks.recordAssistantReply.mockResolvedValue({ handedOffNow: false, suppressed: true })
    mocks.loadChat.mockResolvedValueOnce({ ...CHAT }).mockResolvedValueOnce({ ...CHAT, handedOff: true, mode: "fallback" })
    const res = await call({ token, text: "hi" })
    expect(await res.json()).toEqual({ mode: "fallback", staffName: null })
    expect(mocks.notifyStaffOfHandoff).not.toHaveBeenCalled()
  })

  describe("staff took the chat after the route read it", () => {
    const joined = () => mocks.loadChat.mockResolvedValueOnce({ ...CHAT }).mockResolvedValueOnce({ ...CHAT, mode: "staff", staffFirstName: "Thandi" })

    it("a message the store kept for staff never reaches the model; the re-read mode is returned with no reply", async () => {
      joined()
      mocks.recordVisitorMessage.mockResolvedValue({ accepted: false, reason: "to_staff", stored: true })
      const res = await call({ token, text: "hello?" })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ mode: "staff", staffName: "Thandi" })
      expect(mocks.askAssistant).not.toHaveBeenCalled()
      expect(mocks.recordAssistantReply).not.toHaveBeenCalled()
      expect(mocks.notifyStaffOfHandoff).not.toHaveBeenCalled()
      expect(mocks.logAudit).not.toHaveBeenCalled()
    })

    it("a message past the staff-mode cap is a 429 with the limit notice and the chat's current mode", async () => {
      joined()
      mocks.recordVisitorMessage.mockResolvedValue({ accepted: false, reason: "to_staff", stored: false })
      const res = await call({ token, text: "hello?" })
      expect(res.status).toBe(429)
      expect(await res.json()).toEqual({ mode: "staff", error: LIMIT })
      expect(mocks.askAssistant).not.toHaveBeenCalled()
      expect(mocks.recordAssistantReply).not.toHaveBeenCalled()
    })

    it("a suppressed model reply is discarded: re-read mode, no reply, no hand-off", async () => {
      joined()
      mocks.askAssistant.mockResolvedValue({ needsHuman: true, reason: "complaint", reply: "bot text" })
      mocks.recordAssistantReply.mockResolvedValue({ handedOffNow: false, suppressed: true })
      const res = await call({ token, text: "hi" })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ mode: "staff", staffName: "Thandi" })
      expect(mocks.notifyStaffOfHandoff).not.toHaveBeenCalled()
      expect(mocks.logAudit).not.toHaveBeenCalled()
    })

    it("a suppressed cap hand-off reply is discarded too", async () => {
      joined()
      mocks.recordVisitorMessage.mockResolvedValue({ accepted: false, reason: "conversation_cap", stored: true })
      mocks.recordAssistantReply.mockResolvedValue({ handedOffNow: false, suppressed: true })
      const res = await call({ token, text: "more" })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ mode: "staff", staffName: "Thandi" })
      expect(mocks.notifyStaffOfHandoff).not.toHaveBeenCalled()
    })
  })

  it("a chat that is still a bot chat is not re-read", async () => {
    await call({ token, text: "hi" })
    expect(mocks.loadChat).toHaveBeenCalledOnce()
  })

  it("when the bell fails, the reply and the mode the store opened are still returned, and only message and code are logged", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    handOffNow()
    mocks.notifyStaffOfHandoff.mockRejectedValue(Object.assign(new Error("db down"), { code: "P1001", meta: { phone: "0712345678" } }))
    const res = await call({ token, text: "Do I owe you money?" })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ reply: STORED, handedOff: true, mode: "waiting" })
    expect(mocks.logAudit).toHaveBeenCalledOnce()
    expect(spy).toHaveBeenCalledOnce()
    expect(spy.mock.calls[0][1]).toEqual({ message: "db down", code: "P1001" })
    spy.mockRestore()
  })

  it("an answer in flight when another request handed the chat off is discarded: the visitor is shown the wait, not the answer", async () => {
    mocks.loadChat.mockResolvedValueOnce({ ...CHAT }).mockResolvedValueOnce({ ...CHAT, handedOff: true, mode: "waiting" })
    mocks.recordAssistantReply.mockResolvedValue({ handedOffNow: false, suppressed: true })
    const res = await call({ token, text: "question one" })
    expect(await res.json()).toEqual({ mode: "waiting", staffName: null })
    expect(mocks.notifyStaffOfHandoff).not.toHaveBeenCalled()
    expect(mocks.logAudit).not.toHaveBeenCalled()
  })
})
