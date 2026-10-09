import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { NextRequest } from "next/server"

// A tenant with no lender identity: the chat must not start or answer, and says it is off.
const mocks = vi.hoisted(() => ({
  getTenantFromRequest: vi.fn(), findLenderIdentity: vi.fn(), chatBotsEnabled: vi.fn(),
  startChat: vi.fn(), loadChat: vi.fn(), knowledgeFor: vi.fn(),
}))
vi.mock("@/lib/tenant", () => ({ getTenantFromRequest: mocks.getTenantFromRequest }))
vi.mock("@/lib/config/identity", () => ({ findLenderIdentity: mocks.findLenderIdentity }))
vi.mock("@/lib/website-chat/settings", () => ({ chatBotsEnabled: mocks.chatBotsEnabled }))
vi.mock("@/lib/website-chat/store", () => ({ startChat: mocks.startChat, loadChat: mocks.loadChat }))
vi.mock("@/lib/website-chat/knowledge", () => ({ knowledgeFor: mocks.knowledgeFor }))
vi.mock("@/lib/turnstile", () => ({ verifyTurnstile: async () => ({ ok: true }) }))
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn() }))
vi.mock("@/lib/prisma", () => ({ prisma: {} }))

import { GET as status } from "./status/route"
import { POST as start } from "./start/route"
import { POST as message } from "./message/route"
import { issueChatToken } from "@/lib/website-chat/token"

const req = (body: unknown) => ({ headers: new Headers({ "x-forwarded-for": "1.2.3.4" }), json: async () => body, text: async () => JSON.stringify(body) }) as unknown as NextRequest

describe("chat with no lender identity configured", () => {
  const saved = { key: process.env.ANTHROPIC_API_KEY, secret: process.env.WEBSITE_CHAT_SECRET, proxy: process.env.TRUSTED_PROXY }
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.ANTHROPIC_API_KEY = "test-key"
    process.env.WEBSITE_CHAT_SECRET = "s".repeat(40)
    process.env.TRUSTED_PROXY = "1"
    mocks.getTenantFromRequest.mockResolvedValue({ id: "tenant-1" })
    mocks.chatBotsEnabled.mockResolvedValue(true)
    mocks.findLenderIdentity.mockResolvedValue(null)
    vi.spyOn(console, "error").mockImplementation(() => {})
  })
  afterEach(() => {
    vi.restoreAllMocks()
    for (const [name, value] of [["ANTHROPIC_API_KEY", saved.key], ["WEBSITE_CHAT_SECRET", saved.secret], ["TRUSTED_PROXY", saved.proxy]] as const) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  })

  it("status reports the chat disabled", async () => {
    expect(await (await status(req({}))).json()).toEqual({ enabled: false })
  })
  it("start refuses with the unavailable shape and creates nothing", async () => {
    const res = await start(req({ firstName: "Sam", lastName: "S", phone: "27820000003", email: "s@x.invalid", consent: true }))
    expect(res.status).toBe(503)
    expect((await res.json()).error).toMatch(/not available/i)
    expect(mocks.startChat).not.toHaveBeenCalled()
  })
  it("message refuses and never loads the chat or calls the model", async () => {
    const res = await message(req({ token: issueChatToken("conv-1", new Date()), text: "hi" }))
    expect(res.status).toBe(503)
    expect(mocks.loadChat).not.toHaveBeenCalled()
    expect(mocks.knowledgeFor).not.toHaveBeenCalled()
  })
})
