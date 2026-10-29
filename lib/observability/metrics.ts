import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from "prom-client"
import { UNMATCHED, routeLabel } from "./route-label"

export type CronOutcome = "ok" | "failed" | "tenant_failed" | "error"

export interface Metrics {
  registry: Registry
  httpRequests: Counter<"method" | "route" | "status">
  httpDuration: Histogram<"method" | "route">
  cronRuns: Counter<"job" | "outcome">
  /** Set once the scrape-time database gauges are attached (metrics-collectors.ts). */
  collectorsAttached: boolean
}

// instrumentation.ts, the HTTP server hook and the route handlers are bundled
// separately, so a module-level registry would exist once per bundle and a
// scrape would see only its own. The one registry lives on globalThis.
const KEY = Symbol.for("credaflow.metrics")
const holder = globalThis as { [KEY]?: Metrics }

export function getMetrics(): Metrics {
  const existing = holder[KEY]
  if (existing) return existing
  const registry = new Registry()
  collectDefaultMetrics({ register: registry })
  const created: Metrics = {
    registry,
    collectorsAttached: false,
    httpRequests: new Counter({
      name: "credaflow_http_requests_total",
      help: "HTTP requests served, by method, route (ids collapsed) and status.",
      labelNames: ["method", "route", "status"],
      registers: [registry],
    }),
    httpDuration: new Histogram({
      name: "credaflow_http_request_duration_seconds",
      help: "HTTP request duration in seconds, by method and route (ids collapsed).",
      labelNames: ["method", "route"],
      buckets: [0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
      registers: [registry],
    }),
    cronRuns: new Counter({
      name: "credaflow_cron_runs_total",
      help: "In-process cron runs finished by this process, by job and outcome.",
      labelNames: ["job", "outcome"],
      registers: [registry],
    }),
  }
  holder[KEY] = created
  return created
}

/** `pathname` is the raw request path; it is mapped to a bounded route label here. Every 404 is `unmatched`. */
export function observeHttpRequest(method: string, pathname: string, status: string, seconds: number): void {
  const metrics = getMetrics()
  const route = status === "404" ? UNMATCHED : routeLabel(pathname)
  metrics.httpRequests.inc({ method, route, status })
  metrics.httpDuration.observe({ method, route }, seconds)
}

export function recordCronOutcome(job: string, outcome: CronOutcome): void {
  getMetrics().cronRuns.inc({ job: job.replace("/api/cron/", ""), outcome })
}

export function newGauge<T extends string>(name: string, help: string, labelNames: readonly T[], collect: (gauge: Gauge<T>) => Promise<void>): void {
  new Gauge<T>({
    name,
    help,
    labelNames,
    registers: [getMetrics().registry],
    async collect() {
      await collect(this)
    },
  })
}
