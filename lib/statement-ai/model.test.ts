import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const recordUsage = vi.fn()
vi.mock("./usage", () => ({ recordUsage: (...a: unknown[]) => recordUsage(...a) }))

import { VlmUnavailableError } from "@/lib/statement-analysis/vlm-reader"
import { askModel, modelAvailable, resetModelBackoff } from "./model"

const call = { tenantId: "t1", applicationId: "a1", kind: "SUMMARY" as const, prompt: "p", maxTokens: 10 }

beforeEach(() => {
  vi.stubEnv("VLM_API_URL", "http://vlm.test")
  vi.stubEnv("VLM_MODEL", "stub-model")
  resetModelBackoff()
  recordUsage.mockReset()
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe("askModel", () => {
  it("asks only the configured server, at temperature 0, and meters tokens", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: "hi" } }], usage: { prompt_tokens: 12, completion_tokens: 3 } })))
    vi.stubGlobal("fetch", fetch)
    expect(await askModel(call)).toEqual({ content: "hi", model: "stub-model" })
    expect((fetch.mock.calls[0] as unknown as [string])[0]).toBe("http://vlm.test/v1/chat/completions")
    expect(JSON.parse((fetch.mock.calls[0] as unknown as [string, { body: string }])[1].body)).toMatchObject({ model: "stub-model", temperature: 0, max_tokens: 10 })
    expect(recordUsage).toHaveBeenCalledWith(expect.objectContaining({ tenantId: "t1", kind: "SUMMARY", tokensIn: 12, tokensOut: 3 }))
  })

  // Anthropic's current models answer 400 "temperature is deprecated" to any temperature: a hosted call sends none.
  it("sends no temperature to a hosted model", async () => {
    vi.stubEnv("VLM_API_URL", "https://hosted.test")
    vi.stubEnv("VLM_API_KEY", "test-key-not-real")
    vi.stubEnv("VLM_ALLOW_HOSTED", "true")
    vi.stubEnv("DEMO_MODE", "true")
    vi.stubEnv("STATEMENT_CORPUS_DIR", "")
    vi.stubEnv("VLM_ACCURACY_CORPUS", "")
    const fetch = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: "hi" } }] })))
    vi.stubGlobal("fetch", fetch)
    expect(await askModel(call)).toEqual({ content: "hi", model: "stub-model" })
    const body = JSON.parse((fetch.mock.calls[0] as unknown as [string, { body: string }])[1].body)
    expect(body).toMatchObject({ model: "stub-model", max_tokens: 10 })
    expect(body).not.toHaveProperty("temperature")
  })

  it("meters a failed call too, then backs off without asking", async () => {
    const fetch = vi.fn(async () => new Response("down", { status: 503 }))
    vi.stubGlobal("fetch", fetch)
    await expect(askModel(call)).rejects.toBeInstanceOf(VlmUnavailableError)
    expect(recordUsage).toHaveBeenCalledWith(expect.objectContaining({ tokensIn: null, tokensOut: null }))
    expect(modelAvailable()).toBe(false)
    await expect(askModel(call)).rejects.toThrow(/backing off/)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it("asks nothing when no model is configured", async () => {
    vi.stubEnv("VLM_API_URL", "")
    const fetch = vi.fn()
    vi.stubGlobal("fetch", fetch)
    await expect(askModel(call)).rejects.toBeInstanceOf(VlmUnavailableError)
    expect(fetch).not.toHaveBeenCalled()
  })
})
