import { isIP } from "node:net"
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
 * FAIL MODE: if the shared store errors or does not answer within SHARED_TIMEOUT_MS the
 * call is decided by the in-memory limiter instead, and the shared store is not asked
 * again for BREAKER_MS. A database outage therefore makes limits per-pod (up to N times
 * looser with N replicas), never absent. Each outage is logged once.
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
/** After a failure, how long the in-memory limiter decides alone. */
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

function storeMode(): Mode {
  const configured = process.env.RATE_LIMIT_STORE?.trim().toLowerCase()
  if (configured === "memory" || configured === "postgres") return configured
  if (configured) throw new Error(`RATE_LIMIT_STORE must be "memory" or "postgres", got "${configured}"`)
  return process.env.DATABASE_URL?.trim() ? "postgres" : "memory"
}

let breakerOpenUntil = 0

function withTimeout<T>(work: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`shared rate-limit store did not answer in ${SHARED_TIMEOUT_MS} ms`)), SHARED_TIMEOUT_MS)
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

async function decide(
  namespace: string,
  key: string,
  opts: RateLimitOptions,
  memory: Map<string, Bucket>,
  maxKeys: number,
): Promise<RateLimitResult> {
  if (storeMode() === "memory" || Date.now() < breakerOpenUntil) return checkIn(memory, maxKeys, key, opts)
  try {
    return await withTimeout(checkSharedRateLimit(namespace, key, opts))
  } catch (error) {
    // Logged when the breaker opens, not per request: an outage would otherwise write a line per login attempt.
    console.error("[rate-limit] shared store failed; limits are per pod until it answers again:", error)
    breakerOpenUntil = Date.now() + BREAKER_MS
    return checkIn(memory, maxKeys, key, opts)
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
  breakerOpenUntil = 0
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
