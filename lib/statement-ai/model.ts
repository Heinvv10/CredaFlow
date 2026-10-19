/**
 * The one way this module calls the model: the server at VLM_API_URL
 * (lib/vlm-extract.ts getVlmConfig), self-hosted unless VLM_API_KEY points it
 * at a hosted endpoint.
 * Called only from the background worker (worker.ts), never inside a request.
 * Every call is metered (usage.ts), answered or not.
 */
import type { StatementAiKind } from "@prisma/client"
import { getVlmConfig } from "@/lib/vlm-extract"
import { VlmUnavailableError } from "@/lib/statement-analysis/vlm-reader"
import { recordUsage } from "./usage"

const REQUEST_TIMEOUT_MS = 120_000
/** After the model could not be asked, nothing is asked for this long. */
export const MODEL_BACKOFF_MS = 5 * 60_000
let unavailableUntil = 0

/** Tests only. */
export function resetModelBackoff(): void {
  unavailableUntil = 0
}

export function modelAvailable(): boolean {
  return getVlmConfig() !== null && Date.now() >= unavailableUntil
}

function unavailable(message: string): VlmUnavailableError {
  unavailableUntil = Date.now() + MODEL_BACKOFF_MS
  return new VlmUnavailableError(message)
}

export interface ModelCall {
  tenantId: string
  applicationId: string
  kind: StatementAiKind
  prompt: string
  maxTokens: number
}

export interface ModelAnswer {
  content: string
  model: string
}

/**
 * Asks the model once at temperature 0. Throws VlmUnavailableError when it
 * could not be asked or answered with an HTTP error; an answer it gave, even
 * garbage, is returned for the caller's post-check to judge.
 */
export async function askModel(call: ModelCall): Promise<ModelAnswer> {
  const config = getVlmConfig()
  if (!config) throw new VlmUnavailableError("VLM is not configured")
  if (Date.now() < unavailableUntil) throw new VlmUnavailableError("VLM unavailable recently: backing off")
  const started = Date.now()
  let tokensIn: number | null = null
  let tokensOut: number | null = null
  try {
    let res: Response
    try {
      res = await fetch(config.url, {
        method: "POST",
        headers: config.headers,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        body: JSON.stringify({
          model: config.model,
          messages: [{ role: "user", content: call.prompt }],
          max_tokens: call.maxTokens,
          temperature: 0,
        }),
      })
    } catch (err) {
      throw unavailable(`VLM request failed: ${err instanceof Error ? err.name : "unknown"}`)
    }
    if (!res.ok) {
      await res.body?.cancel()
      throw unavailable(`VLM responded ${res.status}`)
    }
    let body: { choices?: Array<{ message?: { content?: unknown } }>; usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } }
    try {
      body = JSON.parse(await res.text())
    } catch (err) {
      throw unavailable(`VLM response unreadable: ${err instanceof Error ? err.name : "unknown"}`)
    }
    tokensIn = typeof body.usage?.prompt_tokens === "number" ? body.usage.prompt_tokens : null
    tokensOut = typeof body.usage?.completion_tokens === "number" ? body.usage.completion_tokens : null
    const content = body.choices?.[0]?.message?.content
    return { content: typeof content === "string" ? content : "", model: config.model }
  } finally {
    await recordUsage({ tenantId: call.tenantId, applicationId: call.applicationId, kind: call.kind, tokensIn, tokensOut, latencyMs: Date.now() - started })
  }
}
