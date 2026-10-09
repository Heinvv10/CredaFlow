import Anthropic from "@anthropic-ai/sdk"
import { describe, expect, it, vi } from "vitest"
import { askAssistant, HANDOFF_REASON_TEXT, toModelMessages, type ChatTurn } from "./model"

// tsc (not vitest) typechecks this file, so the fake's params must be typed.
type SentParams = {
  model: string
  max_tokens: number
  betas?: unknown
  fallbacks?: unknown
  output_config?: unknown
  tools?: Array<{ name: string; input_schema: { properties: { reason: { enum?: string[] } } } }>
  system: Array<{ cache_control?: unknown }>
}
function fakeClient(impl: () => unknown) {
  const create = vi.fn(async (_params: SentParams, _opts?: unknown) => impl())
  return { client: { beta: { messages: { create } } } as unknown as Anthropic, create }
}
const TURNS: ChatTurn[] = [
  { role: "assistant", text: "Hi, I'm the assistant." },
  { role: "visitor", text: "What are your hours?" },
]

describe("toModelMessages", () => {
  it("drops the leading greeting so the first message is from the user", () => {
    expect(toModelMessages(TURNS)).toEqual([{ role: "user", content: "What are your hours?" }])
  })
})

describe("askAssistant", () => {
  it("returns the text reply", async () => {
    const { client, create } = fakeClient(() => ({ stop_reason: "end_turn", content: [{ type: "text", text: "08:00 to 17:00." }] }))
    expect(await askAssistant("SYS", TURNS, client)).toEqual({ reply: "08:00 to 17:00.", needsHuman: false, reason: null })
    const params = create.mock.calls[0][0]
    expect(params.model).toBe("claude-sonnet-5-5")
    expect(params.fallbacks).toBe("default")
    expect(params.system[0].cache_control).toEqual({ type: "ephemeral" })
  })
  it("sends the pinned request shape and bounded timeout/retries", async () => {
    const { client, create } = fakeClient(() => ({ stop_reason: "end_turn", content: [{ type: "text", text: "ok" }] }))
    await askAssistant("SYS", TURNS, client)
    const [params, opts] = create.mock.calls[0]
    expect(params.max_tokens).toBe(4096)
    expect(params.betas).toEqual(["server-side-fallback-2026-07-01"])
    expect(params.output_config).toEqual({ effort: "low" })
    expect(params.tools?.map((t) => t.name)).toEqual(["hand_off_to_staff"])
    expect(opts).toEqual({ timeout: 20_000, maxRetries: 1 })
  })
  it("flags hand-off when the tool is called, keeping the model's text", async () => {
    const { client } = fakeClient(() => ({
      stop_reason: "tool_use",
      content: [
        { type: "text", text: "A consultant will call you." },
        { type: "tool_use", id: "t1", name: "hand_off_to_staff", input: { reason: "account_question" } },
      ],
    }))
    expect(await askAssistant("SYS", TURNS, client)).toEqual({ reply: "A consultant will call you.", needsHuman: true, reason: "account_question" })
  })
  it("offers the model only the fixed reason codes", async () => {
    const { client, create } = fakeClient(() => ({ stop_reason: "end_turn", content: [{ type: "text", text: "ok" }] }))
    await askAssistant("SYS", TURNS, client)
    expect(create.mock.calls[0][0].tools?.[0].input_schema.properties.reason.enum).toEqual(
      ["asked_for_person", "account_question", "own_quote", "complaint", "distress", "out_of_scope"],
    )
  })
  it.each([
    ["free text carrying visitor details", { reason: "Thandi, ID 8001015009087, wants a call" }],
    ["a missing reason", {}],
    ["a non-string reason", { reason: 42 }],
  ])("never passes on %s: it becomes out_of_scope", async (_label, input) => {
    const { client } = fakeClient(() => ({ stop_reason: "tool_use", content: [{ type: "tool_use", id: "t1", name: "hand_off_to_staff", input }] }))
    expect((await askAssistant("SYS", TURNS, client)).reason).toBe("out_of_scope")
  })
  it("has a staff phrase for every reason, none carrying an HTTP status", () => {
    for (const phrase of Object.values(HANDOFF_REASON_TEXT)) {
      expect(phrase.length).toBeGreaterThan(0)
      expect(phrase).not.toMatch(/\d/)
    }
  })
  it("returns no text of its own when the tool is called with none: the store adds the hand-off line", async () => {
    const { client } = fakeClient(() => ({ stop_reason: "tool_use", content: [{ type: "tool_use", id: "t1", name: "hand_off_to_staff", input: { reason: "asked_for_person" } }] }))
    expect(await askAssistant("SYS", TURNS, client)).toEqual({ reply: "", needsHuman: true, reason: "asked_for_person" })
  })
  it.each([["refusal", "model_refusal"], ["max_tokens", "model_max_tokens"]])("hands off on stop_reason %s, dropping the partial text", async (stop_reason, reason) => {
    const { client } = fakeClient(() => ({ stop_reason, content: [{ type: "text", text: "partial" }] }))
    expect(await askAssistant("SYS", TURNS, client)).toEqual({ reply: "", needsHuman: true, reason })
  })
  it("hands off on an empty reply", async () => {
    const { client } = fakeClient(() => ({ stop_reason: "end_turn", content: [{ type: "text", text: "  " }] }))
    expect(await askAssistant("SYS", TURNS, client)).toEqual({ reply: "", needsHuman: true, reason: "empty_reply" })
  })
  it("hands off when the API errors", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    const { client } = fakeClient(() => { throw new Anthropic.APIConnectionError({ message: "down" }) })
    expect(await askAssistant("SYS", TURNS, client)).toEqual({ reply: "", needsHuman: true, reason: "assistant_unavailable" })
    spy.mockRestore()
  })
  it("rethrows non-API errors (programming bugs must not be swallowed)", async () => {
    const { client } = fakeClient(() => { throw new TypeError("boom") })
    await expect(askAssistant("SYS", TURNS, client)).rejects.toThrow("boom")
  })
})
