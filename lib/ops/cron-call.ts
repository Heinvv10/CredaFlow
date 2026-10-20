import http from "node:http"
import https from "node:https"

export interface CronCallResult {
  status: number
  /** The parsed JSON response body, or null when it was not JSON (or too large to keep). */
  body: unknown
}

const MAX_BODY_BYTES = 1_000_000

/**
 * The scheduler's call to a cron route (instrumentation.ts), with NO client-side
 * timeout. A nightly run over a large book can take longer than the 300 s that
 * undici's fetch allows for response headers, and a call that gave up at 300 s
 * would be recorded as FAILED while the run was still going, so its +30 minute
 * retry would start a second one beside it. The run's liveness is the claim's
 * heartbeat instead (lib/ops/cron-run-claim.ts).
 *
 * node:http(s) rather than fetch because undici's timeouts are not configurable
 * without importing undici, which is not a direct dependency. `agent: false` opens
 * a connection of its own, so no pooled socket's idle timeout can cut a long run.
 * Rejects when the connection fails.
 */
export function callCronRoute(url: string, method: "GET" | "POST", secret: string): Promise<CronCallResult> {
  const target = new URL(url)
  const transport = target.protocol === "https:" ? https : http
  return new Promise((resolve, reject) => {
    const req = transport.request(target, { method, headers: { "x-cron-secret": secret }, agent: false }, (res) => {
      const chunks: Buffer[] = []
      let size = 0
      res.on("data", (chunk: Buffer) => {
        size += chunk.length
        if (size <= MAX_BODY_BYTES) chunks.push(chunk)
      })
      res.on("error", reject)
      res.on("end", () => {
        let body: unknown = null
        if (size <= MAX_BODY_BYTES) {
          try {
            body = JSON.parse(Buffer.concat(chunks).toString("utf8"))
          } catch {
            body = null
          }
        }
        resolve({ status: res.statusCode ?? 0, body })
      })
    })
    req.on("error", reject)
    req.end()
  })
}
