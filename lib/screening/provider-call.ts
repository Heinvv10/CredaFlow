import { SCREENING_TIMEOUT_MS } from "./policy"
import { getScreeningProvider } from "./registry"
import {
  ScreeningProviderError,
  type ScreeningProvider,
  type ScreeningProviderResult,
  type ScreeningSubject,
} from "./types"

export type ProviderOutcome =
  | { ok: true; value: ScreeningProviderResult }
  | { ok: false; code: string; message: string }

function whenAborted(signal: AbortSignal, timeoutMs: number): Promise<never> {
  return new Promise((_, reject) => {
    signal.addEventListener("abort", () => {
      reject(new ScreeningProviderError("TIMEOUT", `The screening provider did not answer within ${timeoutMs} ms`))
    }, { once: true })
  })
}

/**
 * One provider call, bounded by a timeout: the signal is handed to the
 * adapter, and the call is abandoned when it fires even if the adapter
 * ignores it. Any failure comes back as an outcome, never a throw: it is
 * recorded as ERROR rows (state INCOMPLETE), which block approval. A provider
 * that could not answer is never read as "clear".
 */
export async function callProvider(
  key: string,
  subject: ScreeningSubject,
  timeoutMs: number = SCREENING_TIMEOUT_MS,
): Promise<{ provider: ScreeningProvider | null; outcome: ProviderOutcome }> {
  let provider: ScreeningProvider | null = null
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    provider = getScreeningProvider(key)
    const value = await Promise.race([
      provider.screen(subject, provider.supportedTypes, { signal: controller.signal }),
      whenAborted(controller.signal, timeoutMs),
    ])
    return { provider, outcome: { ok: true, value } }
  } catch (error) {
    const code = error instanceof ScreeningProviderError ? error.code : "PROVIDER_ERROR"
    const message = error instanceof Error ? error.message : String(error)
    return { provider, outcome: { ok: false, code, message } }
  } finally {
    clearTimeout(timer)
  }
}
