/**
 * One bureau enquiry across the tenant's bureaus, primary first.
 *
 * FALLBACK RULE. The run moves to the next bureau when an attempt fails for a
 * reason that belongs to the BUREAU: it timed out, errored, is not configured
 * or implemented, is unknown, or may not be simulated here. It STOPS when:
 *  - a bureau returns a report (OK) — one report per run, never a second
 *    billable enquiry on the consumer's record for comparison; or
 *  - a bureau rejects the SUBJECT (consent, invalid or mismatched ID, minor):
 *    another bureau would reject the same request, and asking it would only
 *    spend a second enquiry; or
 *  - `beforeAttempt` says the caller's work went stale (a newer review).
 * Every attempt is returned, in order, for the caller to persist.
 *
 * A timed-out attempt is abandoned, not cancelled: adapters receive an
 * AbortSignal, but the existing Experian/TransUnion clients do not take one,
 * so their request may still complete (and be billed) after the run moved on.
 */
import { getBureauProvider } from "./registry"
import { redactIdNumbers } from "./normalise"
import {
  BureauProviderError,
  type BureauAttempt,
  type BureauAttemptStatus,
  type BureauCredentials,
  type BureauEnquiryRequest,
  type BureauProvider,
} from "./types"

/** Above Experian's own 20 s client timeout, so its classified error wins. */
export const DEFAULT_BUREAU_ATTEMPT_TIMEOUT_MS = 25_000

export interface RunBureauEnquiryArgs {
  request: BureauEnquiryRequest
  order: readonly string[]
  /** Called only for a provider that declares credential fields. May throw. */
  credentialsFor: (providerId: string) => BureauCredentials | null
  timeoutMs?: number
  /** Checked before every attempt; false stops the run as stale. */
  beforeAttempt?: () => Promise<boolean>
  /** Test seam; defaults to the registry. */
  resolve?: (id: string) => BureauProvider | null
}

export interface BureauEnquiryRun {
  attempts: BureauAttempt[]
  report: Extract<BureauAttempt, { status: "OK" }> | null
  stale: boolean
}

const CODE_STATUS: Record<BureauProviderError["code"], Exclude<BureauAttemptStatus, "OK">> = {
  UNKNOWN_PROVIDER: "UNKNOWN_PROVIDER",
  NOT_CONFIGURED: "NOT_CONFIGURED",
  NOT_IMPLEMENTED: "NOT_IMPLEMENTED",
  TIMEOUT: "TIMEOUT",
  SIMULATION_FORBIDDEN: "SIMULATION_FORBIDDEN",
  PROVIDER_ERROR: "FAILED",
  SUBJECT_REJECTED: "SUBJECT_REJECTED",
}

async function withTimeout<T>(work: (signal: AbortSignal) => Promise<T>, ms: number, label: string): Promise<T> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new BureauProviderError("TIMEOUT", `${label} did not answer within ${ms} ms`))
    }, ms)
  })
  try {
    return await Promise.race([work(controller.signal), timeout])
  } finally {
    clearTimeout(timer)
  }
}

async function attemptOne(
  args: RunBureauEnquiryArgs,
  providerId: string,
  attempt: number,
): Promise<BureauAttempt> {
  const fail = (status: Exclude<BureauAttemptStatus, "OK">, error: string, providerCode: string | null = null, errorClass: string | null = null): BureauAttempt =>
    ({ attempt, provider: providerId, status, error: redactIdNumbers(error), providerCode, errorClass })

  const provider = (args.resolve ?? getBureauProvider)(providerId)
  if (!provider) return fail("UNKNOWN_PROVIDER", `Unknown credit bureau "${providerId}"`)
  try {
    const credentials = provider.credentialFields.length > 0 ? args.credentialsFor(provider.id) : null
    const report = await withTimeout(
      (signal) => provider.enquiry(args.request, { credentials, signal }),
      args.timeoutMs ?? DEFAULT_BUREAU_ATTEMPT_TIMEOUT_MS,
      provider.displayName,
    )
    return { attempt, provider: providerId, status: "OK", report }
  } catch (error) {
    if (error instanceof BureauProviderError) {
      return fail(CODE_STATUS[error.code], error.message, error.detail.providerCode ?? null, error.detail.errorClass ?? null)
    }
    return fail("FAILED", error instanceof Error ? error.message : `${provider.displayName} enquiry failed`)
  }
}

export async function runBureauEnquiry(args: RunBureauEnquiryArgs): Promise<BureauEnquiryRun> {
  const attempts: BureauAttempt[] = []
  for (const providerId of args.order) {
    if (args.beforeAttempt && !(await args.beforeAttempt())) {
      return { attempts, report: null, stale: true }
    }
    const result = await attemptOne(args, providerId, attempts.length + 1)
    attempts.push(result)
    if (result.status === "OK") return { attempts, report: result, stale: false }
    if (result.status === "SUBJECT_REJECTED") break
  }
  return { attempts, report: null, stale: false }
}
