import http from "node:http"
import https from "node:https"

/** The response header a single-run cron route sets to the number of tenants whose run threw. */
export const FAILED_TENANTS_HEADER = "x-cron-failed-tenants"

/**
 * The longest a cron call may take. It is far above any real run and exists only so
 * that a route that hangs cannot keep the claim's heartbeat (and so the claim) alive
 * for ever.
 */
export const CALL_CEILING_MS = 55 * 60_000

export interface CronCallResult {
  status: number
  /** The parsed JSON response body, or null when it was not JSON or was past the size cap. */
  body: unknown
  /** The failed-tenants header as a count, or null when it is absent or not a count. */
  failedTenants: number | null
}

export interface CronCallOptions {
  /** Sent as the Host header, so tenant resolution by domain sees the public host. */
  host?: string
  ceilingMs?: number
}

const MAX_BODY_BYTES = 1_000_000

/**
 * Where the in-process scheduler sends its calls: this very server, on loopback, at
 * its own port. Not NEXTAUTH_URL: that is the public origin, behind a TLS proxy with
 * its own timeouts (nginx 60 s, Cloudflare 100 s), and a 504 from the proxy would
 * mark a run that is still going FAILED. The public host still goes as the Host
 * header, so a route that resolves its tenant from the host resolves it as before.
 * `CRON_BASE_URL` overrides the whole target (no Host is sent with it).
 * The image binds HOSTNAME=0.0.0.0 and PORT=3300 (Dockerfile).
 */
export function cronCallTarget(env: Partial<Record<string, string>>): { baseUrl: string; host?: string } {
  if (env.CRON_BASE_URL) return { baseUrl: env.CRON_BASE_URL.replace(/\/+$/, "") }
  const baseUrl = `http://127.0.0.1:${env.PORT ?? 3300}`
  try {
    return env.NEXTAUTH_URL ? { baseUrl, host: new URL(env.NEXTAUTH_URL).host } : { baseUrl }
  } catch {
    return { baseUrl }
  }
}

/**
 * The scheduler's call to a cron route (instrumentation.ts), with NO client-side
 * timeout but the ceiling. A nightly run over a large book can take longer than the
 * 300 s that undici's fetch allows for response headers, and a call that gave up at
 * 300 s would be recorded as FAILED while the run was still going, so its +30 minute
 * retry would start a second one beside it. The run's liveness is the claim's
 * heartbeat instead (lib/ops/cron-run-claim.ts).
 *
 * node:http(s) rather than fetch because undici's timeouts are not configurable
 * without importing undici, which is not a direct dependency. `agent: false` opens
 * a connection of its own, so no pooled socket's idle timeout can cut a long run.
 * Rejects when the connection fails or the ceiling is reached.
 */
export function callCronRoute(url: string, method: "GET" | "POST", secret: string, options: CronCallOptions = {}): Promise<CronCallResult> {
  const target = new URL(url)
  const transport = target.protocol === "https:" ? https : http
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { "x-cron-secret": secret }
    if (options.host) headers.host = options.host
    const ceiling = options.ceilingMs ?? CALL_CEILING_MS
    const req = transport.request(target, { method, headers, agent: false }, (res) => {
      const chunks: Buffer[] = []
      let size = 0
      res.on("data", (chunk: Buffer) => {
        size += chunk.length
        if (size <= MAX_BODY_BYTES) chunks.push(chunk)
      })
      res.on("error", (err) => {
        clearTimeout(timer)
        reject(err)
      })
      res.on("end", () => {
        clearTimeout(timer)
        let body: unknown = null
        if (size <= MAX_BODY_BYTES) {
          try {
            body = JSON.parse(Buffer.concat(chunks).toString("utf8"))
          } catch {
            body = null
          }
        }
        const raw = res.headers[FAILED_TENANTS_HEADER]
        const header = Array.isArray(raw) ? raw[0] : raw
        resolve({ status: res.statusCode ?? 0, body, failedTenants: header !== undefined && /^\d+$/.test(header) ? Number(header) : null })
      })
    })
    const timer = setTimeout(() => req.destroy(new Error(`cron call exceeded its ${ceiling} ms ceiling`)), ceiling)
    req.on("error", (err) => {
      clearTimeout(timer)
      reject(err)
    })
    req.end()
  })
}
