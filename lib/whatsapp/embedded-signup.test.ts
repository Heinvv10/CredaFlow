import { afterEach, describe, it, expect, vi } from "vitest"
import { exchangeCodeForToken, subscribeAppToWaba } from "./embedded-signup"

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals() })

describe("exchangeCodeForToken", () => {
  it("exchanges an auth code for a business access token", async () => {
    vi.stubEnv("WHATSAPP_GRAPH_VERSION", "v23.0")
    vi.stubEnv("NEXT_PUBLIC_META_APP_ID", "APP1")
    vi.stubEnv("WHATSAPP_CLOUD_APP_SECRET", "SECRET1")
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ access_token: "EAAB-biz" }) })
    vi.stubGlobal("fetch", fetchSpy)

    expect(await exchangeCodeForToken("AUTHCODE")).toBe("EAAB-biz")
    const url = fetchSpy.mock.calls[0][0] as string
    expect(url).toContain("/v23.0/oauth/access_token")
    expect(url).toContain("client_id=APP1")
    expect(url).toContain("code=AUTHCODE")
  })

  it("throws when Meta returns no token", async () => {
    vi.stubEnv("NEXT_PUBLIC_META_APP_ID", "APP1")
    vi.stubEnv("WHATSAPP_CLOUD_APP_SECRET", "SECRET1")
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 400, text: async () => "bad code" }))
    await expect(exchangeCodeForToken("x")).rejects.toThrow(/400/)
  })
})

describe("subscribeAppToWaba", () => {
  it("POSTs to the WABA subscribed_apps endpoint", async () => {
    vi.stubEnv("WHATSAPP_GRAPH_VERSION", "v23.0")
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ success: true }) })
    vi.stubGlobal("fetch", fetchSpy)
    await subscribeAppToWaba("WABA1", "EAAB-biz")
    expect(fetchSpy.mock.calls[0][0]).toBe("https://graph.facebook.com/v23.0/WABA1/subscribed_apps")
    expect((fetchSpy.mock.calls[0][1] as RequestInit).method).toBe("POST")
  })
})
