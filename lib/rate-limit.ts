import { isIP } from "node:net"

/**
 * In-memory sliding-window rate limiter.
 *
 * Suitable for single-replica deployments only. When you scale to >1 web
 * replica, replace `store` with a Redis-backed implementation — the public
 * `checkRateLimit` API can stay the same.
 *
 * Each call records a timestamp under the given key and reports whether the
 * caller is currently over the limit. Old timestamps outside the window are
 * GC'd lazily on every check, so memory stays bounded by active keys.
 */

type Bucket = number[]

const store = new Map<string, Bucket>()

// Cap the number of distinct keys we track so a flood of unique keys (e.g.
// random IPs) can't blow up memory. The cheapest eviction policy that still
// works for a rate limiter is "drop oldest insertion" — Map preserves order.
const MAX_KEYS = 10_000

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

export function checkRateLimit(key: string, opts: RateLimitOptions): RateLimitResult {
  const now = Date.now()
  const cutoff = now - opts.windowMs

  let bucket = store.get(key)
  if (!bucket) {
    bucket = []
    if (store.size >= MAX_KEYS) {
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
    const retryAfterMs = bucket[0] + opts.windowMs - now
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

/** Clear all rate-limit state. Test helper; do not call from request paths. */
export function _resetRateLimitStore(): void {
  store.clear()
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
