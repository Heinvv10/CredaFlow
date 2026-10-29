import { isIP } from "node:net"
import { classify, FAIL_CLOSED_RETRY_SECONDS } from "./rate-limit-groups"
import { SharedStoreUnavailableError } from "./rate-limit-errors"
import { checkSharedRateLimit } from "./rate-limit-store"

/**
 * Sliding-window rate limiter.
 *
 * Two stores behind one async API. `postgres` (the default when DATABASE_URL is set)
 * keeps the window in the RateLimitHit table, so a limit holds across every web
 * replica and survives a restart (lib/rate-limit-store.ts). `memory` keeps it in this
 * process: per-pod limits, for tests, local development and a database-less run.
 * RATE_LIMIT_STORE=memory|postgres chooses explicitly; any other value throws.
 *
 * FAIL MODE (lib/rate-limit-groups.ts says which limits are authentication limits):
 *  - A call whose pool has no free connection, or that TIMES OUT (a lock held on its key, SHARED_TIMEOUT_MS), concerns that call alone:
 *    an authentication limit refuses it, any other is decided by the in-memory limiter. Nothing else changes.
 *  - A database ERROR counts towards an outage: after FAILURES_TO_OPEN in a row the group's store is not asked for
 *    BREAKER_MS, and meanwhile an authentication group refuses (sign-in needs the database anyway) while any other is
 *    decided in memory (per pod, up to N times looser, never absent). The breaker is per group.
 * An outage is logged once.
 *
 * Each call records a hit under the given key and reports whether the caller is
 * over the limit. A refused call records nothing.
 */

type Bucket = number[]

const store = new Map<string, Bucket>()
// Every store, so the test reset clears limiters made with createRateLimiter too.
const allStores = new Set<Map<string, Bucket>>([store])

// Cap the number of distinct keys we track so a flood of unique keys (e.g.
// random IPs) can't blow up memory. The cheapest eviction policy that still
// works for a rate limiter is "drop oldest insertion" — Map preserves order.
const MAX_KEYS = 10_000

/** How long a shared-store call may take before it counts as a failure. */
const SHARED_TIMEOUT_MS = 1500
/** After this many failures in a row for a group, its shared store is not asked for BREAKER_MS. */
const FAILURES_TO_OPEN = 3
const BREAKER_MS = 30_000

export interface RateLimitResult {
  allowed: boolean
  remaining: number
  retryAfterSeconds: number
}

export interface RateLimitOptions {
  /** Number of attempts allowed inside the window. */
  limit: number
  /** Window length in milliseconds. */
  windowMs: number
}

type Mode = "memory" | "postgres"

/** Throws on an unusable RATE_LIMIT_STORE. Called at boot (instrumentation.ts) so a typo stops the deploy, not each login. */
export function assertRateLimitStoreConfig(): void {
  storeMode()
}

function storeMode(): Mode {
  const configured = process.env.RATE_LIMIT_STORE?.trim().toLowerCase()
  if (configured === "memory" || configured === "postgres") return configured
  if (configured) throw new Error(`RATE_LIMIT_STORE must be "memory" or "postgres", got "${configured}"`)
  return process.env.DATABASE_URL?.trim() ? "postgres" : "memory"
}

/** Consecutive failures and the end of the open period, per group: one group's outage does not move the others. */
const health = new Map<string, { failures: number; openUntil: number }>()

function withTimeout<T>(work: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new SharedStoreUnavailableError(`shared rate-limit store did not answer in ${SHARED_TIMEOUT_MS} ms`, { kind: "timeout" })), SHARED_TIMEOUT_MS)
    work.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

const refusedWhileDown = (): RateLimitResult => ({ allowed: false, remaining: 0, retryAfterSeconds: FAIL_CLOSED_RETRY_SECONDS })

async function decide(
  namespace: string,
  key: string,
  opts: RateLimitOptions,
  memory: Map<string, Bucket>,
  maxKeys: number,
): Promise<RateLimitResult> {
  const { group, failClosed, podLocal } = classify(namespace, key)
  if (podLocal || storeMode() === "memory") return checkIn(memory, maxKeys, key, opts)
  const state = health.get(group)
  if (state && Date.now() < state.openUntil) return failClosed ? refusedWhileDown() : checkIn(memory, maxKeys, key, opts)
  try {
    const result = await withTimeout(checkSharedRateLimit(namespace, key, opts, group))
    health.delete(group)
    return result
  } catch (error) {
    // Only the store being unavailable degrades (to a refusal, or the in-memory limiter, by group). Anything else is
    // a bug (a TypeError, a bad argument) and is thrown to the caller: it must not be hidden as an outage.
    if (!(error instanceof SharedStoreUnavailableError)) throw error
    // A full pool is local congestion, not the database being down, and opens nothing. This call is refused (an
    // authentication limit) or decided in memory (any other): never an authentication call in memory.
    if (error.kind === "saturated") return failClosed ? refusedWhileDown() : checkIn(memory, maxKeys, key, opts)
    // A timeout concerns this call alone (a lock held on this one key, a busy pool): it is refused, or served from memory,
    // and no other key is affected. Whoever can stall one key must not be able to refuse the rest.
    if (error.kind === "timeout") return failClosed ? refusedWhileDown() : checkIn(memory, maxKeys, key, opts)
    // A database error is an outage once it repeats: then the group is not asked for a while, and an authentication group
    // refuses meanwhile (sign-in needs the database too, so nothing that would have worked is lost).
    const failures = (state?.failures ?? 0) + 1
    const opens = failures >= FAILURES_TO_OPEN
    health.set(group, { failures, openUntil: opens ? Date.now() + BREAKER_MS : 0 })
    // First failure of an outage, and when the breaker opens: not one line per request.
    if (failures === 1 || failures === FAILURES_TO_OPEN) {
      console.error(`[rate-limit] shared store unavailable for "${group}" (${failures} in a row); ${failClosed ? "refusing these attempts" : "limits are per pod"} until it answers again:`, error)
    }
    return failClosed ? refusedWhileDown() : checkIn(memory, maxKeys, key, opts)
  }
}

/**
 * A limiter with its own in-memory store and cap, and its own key namespace in the
 * shared store. Use one where keys of different kinds must not evict each other: a
 * flood of unique keys of one kind (failed attempts from random addresses) would
 * otherwise push out the buckets of another (a real API key already at its limit),
 * lifting that limit. `namespace` must be stable across replicas and releases.
 */
export function createRateLimiter(maxKeys: number, namespace: string): (key: string, opts: RateLimitOptions) => Promise<RateLimitResult> {
  const own = new Map<string, Bucket>()
  allStores.add(own)
  return (key, opts) => decide(namespace, key, opts, own, maxKeys)
}

/**
 * A limiter that is per process on purpose, whatever RATE_LIMIT_STORE says: for a
 * sampling decision (how many log rows to write) where a database round trip per
 * call would cost more than the limit protects.
 */
export function createLocalRateLimiter(maxKeys: number): (key: string, opts: RateLimitOptions) => RateLimitResult {
  const own = new Map<string, Bucket>()
  allStores.add(own)
  return (key, opts) => checkIn(own, maxKeys, key, opts)
}

export function checkRateLimit(key: string, opts: RateLimitOptions): Promise<RateLimitResult> {
  return decide("", key, opts, store, MAX_KEYS)
}

function checkIn(store: Map<string, Bucket>, maxKeys: number, key: string, opts: RateLimitOptions): RateLimitResult {
  const now = Date.now()
  const cutoff = now - opts.windowMs

  let bucket = store.get(key)
  if (!bucket) {
    bucket = []
    if (store.size >= maxKeys) {
      // Drop the oldest tracked key to bound memory.
      const oldest = store.keys().next().value
      if (oldest !== undefined) store.delete(oldest)
    }
    store.set(key, bucket)
  }

  // Discard entries that fell out of the window.
  while (bucket.length > 0 && bucket[0] < cutoff) {
    bucket.shift()
  }

  if (bucket.length >= opts.limit) {
    const retryAfterMs = (bucket[0] ?? now) + opts.windowMs - now
    return {
      allowed: false,
      remaining: 0,
      retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)),
    }
  }

  bucket.push(now)
  return {
    allowed: true,
    remaining: opts.limit - bucket.length,
    retryAfterSeconds: 0,
  }
}

/** Clear all in-memory rate-limit state and close the breaker. Test helper; do not call from request paths. */
export function _resetRateLimitStore(): void {
  for (const s of allStores) s.clear()
  health.clear()
}

/**
 * Extract the caller's real IP using the rightmost-trusted algorithm.
 *
 * Set TRUSTED_PROXY env var to the number of proxies (CDN, load-balancer, etc.)
 * between the internet and this app. Each trusted proxy appended the real client
 * IP it saw; reading from the right skips any client-controlled fake entries.
 *
 *   TRUSTED_PROXY=0 (default): XFF is fully attacker-controlled — ignore it
 *   TRUSTED_PROXY=1: one LB in front — take rightmost XFF entry
 *   TRUSTED_PROXY=2: CDN + LB — take second-from-right XFF entry
 *
 * Falls back to "unknown" when the header is absent or the chain is too short.
 * "unknown" is a valid rate-limit key — it buckets all direct/proxy-stripped
 * callers together, which is conservative but not exploitable.
 */
export function callerIp(req: Request): string {
  return callerIpFromHeaders(req.headers)
}

/**
 * callerIp for code that holds the request headers rather than the Request
 * (a NextAuth callback reading `headers()` from next/headers). Same algorithm.
 */
export function callerIpFromHeaders(headers: Headers): string {
  const trustedProxies = parseInt(process.env.TRUSTED_PROXY ?? "0", 10)

  const forwarded = trustedForwardedIp(headers, trustedProxies)
  if (forwarded) return forwarded

  return "unknown"
}

function trustedForwardedIp(headers: Headers, trustedProxies: number): string | null {
  const xff = headers.get("x-forwarded-for")
  if (!xff || trustedProxies <= 0) return null
  const ips = xff.split(",").map((s) => s.trim()).filter(Boolean)
  const idx = ips.length - trustedProxies
  if (idx < 0 || !isIP(ips[idx]!)) return null
  return ips[idx]!
}

/**
 * callerIp for a record rather than a rate-limit key: null instead of the
 * "unknown" bucket when no trusted proxy supplied an address, so an access
 * or audit row never stores a placeholder as if it were an IP.
 */
export function recordedCallerIp(req: Request): string | null {
  const trustedProxies = parseInt(process.env.TRUSTED_PROXY ?? "0", 10)
  return trustedForwardedIp(req.headers, trustedProxies)
}
