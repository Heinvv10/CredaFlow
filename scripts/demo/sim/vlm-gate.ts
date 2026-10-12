/**
 * Pacing for the one thing the bake makes the app send to the shared VLM:
 * document extraction. The VLM (127.0.0.1:8100) also serves FibreFlow
 * production, whose health probe (30 s timeout, every 5 min) restarts vLLM
 * when it is slow to answer; an unpaced bake did that three times.
 *
 *   - One in flight: `vlmSlot` starts its work only after every earlier slot
 *     in this process has finished, whichever scenario opened it.
 *   - A pause after each: a slot is held `pauseMs` after its work ends
 *     (SIM_VLM_PAUSE_MS, default 5000).
 *   - Retry with backoff: `extractWithRetry` re-runs a failed extraction after
 *     each delay in `backoffMs` (SIM_VLM_RETRY_BACKOFF_MS, comma-separated,
 *     default 30000,60000,120000) and throws once they are spent, which fails
 *     the persona and so the bake.
 *
 * A portal upload is extracted in the background (POST /api/documents answers
 * 201, then calls the VLM), so the work inside a slot must wait for the
 * document to leave `processing`, not just for the upload to answer.
 */
import { log } from "./env"

export interface VlmPacing {
  pauseMs: number
  backoffMs: number[]
}

export type ExtractionAttempt = { ok: true } | { ok: false; reason: string }

export type Sleep = (ms: number) => Promise<void>

const sleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function wholeMs(value: string, name: string): number {
  const n = Number(value)
  if (value === "" || !Number.isInteger(n) || n < 0) throw new Error(`${name}: "${value}" is not a whole number of milliseconds`)
  return n
}

export function vlmPacing(env: Record<string, string | undefined> = process.env): VlmPacing {
  return {
    pauseMs: wholeMs(env.SIM_VLM_PAUSE_MS ?? "5000", "SIM_VLM_PAUSE_MS"),
    backoffMs: (env.SIM_VLM_RETRY_BACKOFF_MS ?? "30000,60000,120000")
      .split(",")
      .map((v) => wholeMs(v.trim(), "SIM_VLM_RETRY_BACKOFF_MS")),
  }
}

let tail: Promise<unknown> = Promise.resolve()

/** Runs `work` once no other slot is open, then holds the slot for the pause. */
export function vlmSlot<T>(label: string, work: () => Promise<T>, pacing = vlmPacing(), wait: Sleep = sleep): Promise<T> {
  const run = tail.then(async () => {
    const opened = Date.now()
    log(`vlm-slot open  ${new Date(opened).toISOString()} ${label}`)
    try {
      return await work()
    } finally {
      log(`vlm-slot close ${new Date().toISOString()} ${label} (${((Date.now() - opened) / 1000).toFixed(1)}s), pause ${pacing.pauseMs} ms`)
      await wait(pacing.pauseMs)
    }
  })
  tail = run.catch(() => undefined)
  return run
}

async function attempt(fn: () => Promise<ExtractionAttempt>): Promise<ExtractionAttempt> {
  try {
    return await fn()
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) }
  }
}

/** `first`, then `retry` after each backoff delay while it fails; throws when the delays run out. */
export async function extractWithRetry(
  label: string,
  first: () => Promise<ExtractionAttempt>,
  retry: () => Promise<ExtractionAttempt>,
  pacing = vlmPacing(),
  wait: Sleep = sleep,
): Promise<void> {
  let result = await attempt(first)
  for (const [i, delay] of pacing.backoffMs.entries()) {
    if (result.ok) return
    log(`${label}: extraction failed (${result.reason}); retry ${i + 1}/${pacing.backoffMs.length} in ${delay / 1000}s`)
    await wait(delay)
    result = await attempt(retry)
  }
  if (!result.ok) {
    throw new Error(`${label}: extraction still failing after ${pacing.backoffMs.length} retries: ${result.reason}`)
  }
}
