import Anthropic from "@anthropic-ai/sdk"

export type ChatTurn = { role: "visitor" | "assistant"; text: string }

/** The only reasons the model may give. Free text would let a visitor's words reach the staff note. */
const MODEL_HANDOFF_REASONS = ["asked_for_person", "account_question", "own_quote", "complaint", "distress", "out_of_scope"] as const
type ModelHandoffReason = (typeof MODEL_HANDOFF_REASONS)[number]
/** Model reasons plus the ones the server sets itself. */
export type HandoffReason =
  | ModelHandoffReason
  | "message_limit" | "daily_limit" | "assistant_unavailable" | "model_refusal" | "model_max_tokens" | "empty_reply"

/** Staff-facing phrase for each reason; completes "Needs human: <phrase>." */
export const HANDOFF_REASON_TEXT: Record<HandoffReason, string> = {
  asked_for_person: "the visitor asked for a person",
  account_question: "a question about an existing account",
  own_quote: "the visitor wants a quote for their own situation",
  complaint: "a complaint",
  distress: "the visitor may be in financial distress",
  out_of_scope: "a question the assistant cannot answer",
  message_limit: "the chat reached its message limit",
  daily_limit: "the assistant's daily limit was reached, so the visitor's question above was not answered",
  assistant_unavailable: "the assistant was unavailable",
  model_refusal: "the assistant declined to answer",
  model_max_tokens: "the assistant's reply was cut off",
  empty_reply: "the assistant gave an empty reply",
}

/**
 * For a hand-off, `reply` is only the model's own text, often empty: the store adds the line
 * saying what happens next (handoff-line.ts), since only it knows whether anyone is there.
 */
export type AssistantResult = { reply: string; needsHuman: boolean; reason: HandoffReason | null }

const MODEL = "claude-sonnet-5-5"

const HANDOFF_TOOL: Anthropic.Beta.BetaTool = {
  name: "hand_off_to_staff",
  description: "Flag this chat for a human consultant to phone the visitor back. Use it whenever the rules say to hand off.",
  input_schema: {
    type: "object",
    properties: { reason: { type: "string", enum: [...MODEL_HANDOFF_REASONS], description: "Why a person is needed." } },
    required: ["reason"],
    additionalProperties: false,
  },
  strict: true,
}

/** The API needs the first message to be the user's; the stored greeting is not. */
export function toModelMessages(turns: ChatTurn[]): Anthropic.Beta.BetaMessageParam[] {
  const firstVisitor = turns.findIndex((t) => t.role === "visitor")
  if (firstVisitor === -1) return []
  return turns.slice(firstVisitor).map((t) => ({ role: t.role === "visitor" ? "user" : "assistant", content: t.text }))
}

function handoff(reason: HandoffReason): AssistantResult {
  return { reply: "", needsHuman: true, reason }
}

export async function askAssistant(systemPrompt: string, turns: ChatTurn[], client: Anthropic = new Anthropic()): Promise<AssistantResult> {
  let response: Anthropic.Beta.BetaMessage
  try {
    response = await client.beta.messages.create(
      {
        model: MODEL,
        max_tokens: 4096,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        output_config: { effort: "low" },
        system: [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }],
        tools: [HANDOFF_TOOL],
        messages: toModelMessages(turns),
      },
      { timeout: 20_000, maxRetries: 1 },
    )
  } catch (err) {
    if (err instanceof Anthropic.APIError) {
      console.error("[website-chat] Claude API error:", err.status, err.message)
      return handoff("assistant_unavailable")
    }
    throw err
  }

  if (response.stop_reason === "refusal") return handoff("model_refusal")
  if (response.stop_reason === "max_tokens") return handoff("model_max_tokens")
  const text = response.content
    .flatMap((b) => (b.type === "text" ? [b.text] : []))
    .join("\n")
    .trim()
  const tool = response.content.find((b) => b.type === "tool_use" && b.name === "hand_off_to_staff")
  if (tool && tool.type === "tool_use") {
    const input = tool.input as { reason?: unknown }
    const reason = MODEL_HANDOFF_REASONS.find((r) => r === input.reason) ?? "out_of_scope"
    return { reply: text, needsHuman: true, reason }
  }
  if (!text) return handoff("empty_reply")
  return { reply: text, needsHuman: false, reason: null }
}
