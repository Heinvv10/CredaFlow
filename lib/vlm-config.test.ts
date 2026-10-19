import { afterEach, describe, expect, it, vi } from "vitest"
import { getVlmConfig } from "./vlm-extract"

describe("getVlmConfig headers", () => {
  afterEach(() => vi.unstubAllEnvs())

  it("sends no Authorization header when VLM_API_KEY is unset", () => {
    vi.stubEnv("VLM_API_URL", "http://vlm.test:8100/")
    vi.stubEnv("VLM_MODEL", "test-model")
    vi.stubEnv("VLM_API_KEY", "")
    expect(getVlmConfig()).toEqual({
      url: "http://vlm.test:8100/v1/chat/completions",
      model: "test-model",
      headers: { "Content-Type": "application/json" },
    })
  })

  it("sends the key as a bearer token when VLM_API_KEY is set", () => {
    vi.stubEnv("VLM_API_URL", "https://hosted.test")
    vi.stubEnv("VLM_MODEL", "test-model")
    vi.stubEnv("VLM_API_KEY", "test-key-not-real")
    expect(getVlmConfig()?.headers).toEqual({ "Content-Type": "application/json", Authorization: "Bearer test-key-not-real" })
  })
})
