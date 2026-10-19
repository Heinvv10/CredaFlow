import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { getVlmConfig, refuseHostedForRealData } from "./vlm-extract"

describe("getVlmConfig", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    vi.stubEnv("VLM_MODEL", "test-model")
    vi.stubEnv("STATEMENT_CORPUS_DIR", "")
    vi.stubEnv("VLM_ACCURACY_CORPUS", "")
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it("sends no Authorization header when VLM_API_KEY is unset", () => {
    vi.stubEnv("VLM_API_URL", "http://vlm.test:8100/")
    vi.stubEnv("VLM_API_KEY", "")
    expect(getVlmConfig()).toEqual({
      url: "http://vlm.test:8100/v1/chat/completions",
      model: "test-model",
      headers: { "Content-Type": "application/json" },
    })
  })

  describe("with VLM_API_KEY (a hosted endpoint)", () => {
    beforeEach(() => {
      vi.stubEnv("VLM_API_URL", "https://hosted.test")
      vi.stubEnv("VLM_API_KEY", "test-key-not-real")
      vi.stubEnv("VLM_ALLOW_HOSTED", "true")
    })

    it("sends the key as a bearer token when hosted use is allowed", () => {
      expect(getVlmConfig()?.headers).toEqual({ "Content-Type": "application/json", Authorization: "Bearer test-key-not-real" })
    })

    it("is not configured without VLM_ALLOW_HOSTED=true", () => {
      vi.stubEnv("VLM_ALLOW_HOSTED", "")
      expect(getVlmConfig()).toBeNull()
    })

    it("never sends the key over plain http", () => {
      vi.stubEnv("VLM_API_URL", "http://hosted.test")
      expect(getVlmConfig()).toBeNull()
    })

    it.each(["STATEMENT_CORPUS_DIR", "VLM_ACCURACY_CORPUS"])("is not configured while %s points at a real corpus", (name) => {
      vi.stubEnv(name, "/srv/corpus")
      expect(getVlmConfig()).toBeNull()
    })
  })
})

describe("refuseHostedForRealData", () => {
  afterEach(() => vi.unstubAllEnvs())

  it.each(["VLM_API_KEY", "VLM_ALLOW_HOSTED"])("refuses corpus tooling while %s is set", (name) => {
    vi.stubEnv("VLM_API_KEY", "")
    vi.stubEnv("VLM_ALLOW_HOSTED", "")
    vi.stubEnv(name, "x")
    expect(() => refuseHostedForRealData()).toThrow(/self-hosted/)
  })

  it("allows the self-hosted model", () => {
    vi.stubEnv("VLM_API_KEY", "")
    vi.stubEnv("VLM_ALLOW_HOSTED", "")
    expect(() => refuseHostedForRealData()).not.toThrow()
  })
})
