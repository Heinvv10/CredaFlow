import http from "node:http"
import { observeHttpRequest } from "./metrics"

// Probes and scrapes would drown the latency histogram in sub-millisecond samples.
const UNCOUNTED = new Set(["/api/metrics", "/api/health/live", "/api/health/ready"])

const KEY = Symbol.for("credaflow.http-metrics.installed")
const holder = globalThis as { [KEY]?: boolean }

/**
 * Counts every HTTP request the Node server answers, and times it. Next gives
 * a standalone server no request hook of its own, so this wraps the "request"
 * event of node:http's Server, which `next start` / server.js listens on.
 * It only reads the response (status when it closes), never alters it. A
 * response closed before it finished is counted with status "aborted".
 */
export function instrumentHttpServer(): void {
  if (holder[KEY]) return
  holder[KEY] = true
  const emit = http.Server.prototype.emit
  http.Server.prototype.emit = function patched(this: http.Server, event: string | symbol, ...args: unknown[]): boolean {
    if (event === "request") {
      const [req, res] = args as [http.IncomingMessage, http.ServerResponse]
      const started = process.hrtime.bigint()
      res.once("close", () => {
        const pathname = (req.url ?? "/").split("?")[0]
        if (UNCOUNTED.has(pathname)) return
        const seconds = Number(process.hrtime.bigint() - started) / 1e9
        observeHttpRequest(req.method ?? "UNKNOWN", pathname, res.writableFinished ? String(res.statusCode) : "aborted", seconds)
      })
    }
    return Reflect.apply(emit, this, [event, ...args]) as boolean
  } as typeof http.Server.prototype.emit
}
