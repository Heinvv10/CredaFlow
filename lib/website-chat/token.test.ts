import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { CHAT_TOKEN_TTL_MS, isChatConfigured, issueChatToken, verifyChatToken } from "./token"

const NOW = new Date("2026-09-29T10:00:00Z")

describe("chat token", () => {
  const savedProxy = process.env.TRUSTED_PROXY
  beforeEach(() => { process.env.WEBSITE_CHAT_SECRET = "x".repeat(40); process.env.TRUSTED_PROXY = "1" })
  afterEach(() => {
    delete process.env.WEBSITE_CHAT_SECRET; delete process.env.ANTHROPIC_API_KEY
    if (savedProxy === undefined) delete process.env.TRUSTED_PROXY
    else process.env.TRUSTED_PROXY = savedProxy
  })

  it("round-trips the conversation id", () => {
    expect(verifyChatToken(issueChatToken("conv_abc", NOW), NOW)).toBe("conv_abc")
  })
  it("rejects a token whose id was swapped", () => {
    const [, exp, mac] = issueChatToken("conv_abc", NOW).split(".")
    expect(verifyChatToken(`conv_other.${exp}.${mac}`, NOW)).toBeNull()
  })
  it("rejects an expired token", () => {
    const t = issueChatToken("conv_abc", NOW)
    expect(verifyChatToken(t, new Date(NOW.getTime() + CHAT_TOKEN_TTL_MS + 1))).toBeNull()
  })
  it("rejects a token signed with another secret", () => {
    const t = issueChatToken("conv_abc", NOW)
    process.env.WEBSITE_CHAT_SECRET = "y".repeat(40)
    expect(verifyChatToken(t, NOW)).toBeNull()
  })
  it("rejects junk", () => {
    for (const junk of [undefined, 42, "", "a.b", "a.b.c.d"]) expect(verifyChatToken(junk, NOW)).toBeNull()
  })
  it("is configured only with both secrets (and a trusted proxy)", () => {
    expect(isChatConfigured()).toBe(false)
    process.env.ANTHROPIC_API_KEY = "sk-test"
    expect(isChatConfigured()).toBe(true)
    process.env.WEBSITE_CHAT_SECRET = "short"
    expect(isChatConfigured()).toBe(false)
  })
  it.each([undefined, "0", "", "junk"])("is not configured when TRUSTED_PROXY is %j", (proxy) => {
    process.env.ANTHROPIC_API_KEY = "sk-test"
    if (proxy === undefined) delete process.env.TRUSTED_PROXY
    else process.env.TRUSTED_PROXY = proxy
    expect(isChatConfigured()).toBe(false)
  })
})
