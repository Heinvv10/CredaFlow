import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const { probeDatabase, recentOutboxFailures, heartbeats } = vi.hoisted(() => ({
  probeDatabase: vi.fn(),
  recentOutboxFailures: vi.fn(),
  heartbeats: vi.fn(),
}))
vi.mock("@/lib/ops/health-checks", () => ({ probeDatabase, recentOutboxFailures }))
vi.mock("@/lib/prisma", () => ({ prisma: { cronHeartbeat: { findMany: heartbeats } } }))

// The path-shape fallback, whatever .next/ a developer has built locally.
vi.mock("@/lib/observability/route-label", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/observability/route-label")>()
  return { ...original, routeLabel: original.createRouteLabeler(null) }
})

import { GET } from "./route"
import { observeHttpRequest, recordCronOutcome } from "@/lib/observability/metrics"

const TOKEN = "metrics-token-for-tests-0123456789"
const scrape = (authorization?: string) =>
  GET(new Request("http://localhost/api/metrics", authorization ? { headers: { authorization } } : undefined))

beforeEach(() => {
  vi.stubEnv("METRICS_TOKEN", TOKEN)
  probeDatabase.mockResolvedValue({ state: "ok", latencyMs: 2 })
  recentOutboxFailures.mockResolvedValue(0)
  heartbeats.mockResolvedValue([])
})
afterEach(() => vi.unstubAllEnvs())

describe("/api/metrics authentication", () => {
  it("does not exist (404) while METRICS_TOKEN is unset", async () => {
    vi.stubEnv("METRICS_TOKEN", "")
    expect((await scrape(`Bearer ${TOKEN}`)).status).toBe(404)
  })

  it("refuses a scrape with no credentials", async () => {
    const response = await scrape()
    expect(response.status).toBe(401)
    expect(response.headers.get("www-authenticate")).toBe("Bearer")
  })

  it.each([
    ["a wrong token", `Bearer ${TOKEN}x`],
    ["a shorter token", "Bearer short"],
    // Same length as the real token: only the byte comparison can refuse it.
    ["a wrong token of the same length", `Bearer ${TOKEN.slice(0, -1)}${TOKEN.endsWith("0") ? "1" : "0"}`],
    ["the right token under another scheme", `Basic ${TOKEN}`],
    ["the bare token", TOKEN],
  ])("refuses %s", async (_label, header) => {
    expect((await scrape(header)).status).toBe(401)
  })

  it("never puts the secret or any metric in a refusal", async () => {
    const text = await (await scrape("Bearer nope")).text()
    expect(text).not.toContain(TOKEN)
    expect(text).not.toContain("credaflow_")
  })

  it("serves the Prometheus text format to the right token", async () => {
    const response = await scrape(`Bearer ${TOKEN}`)
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("text/plain")
    expect(response.headers.get("cache-control")).toBe("no-store")
  })
})

describe("/api/metrics content", () => {
  it("reports request counts and latency with a bounded route label", async () => {
    observeHttpRequest("GET", "/api/loans/2f1c8a9e-1b2c-4d3e-8f90-123456789abc", "200", 0.12)
    const text = await (await scrape(`Bearer ${TOKEN}`)).text()
    expect(text).toContain('credaflow_http_requests_total{method="GET",route="/api/loans/:id",status="200"}')
    expect(text).toContain("credaflow_http_request_duration_seconds_bucket{")
    expect(text).not.toContain("2f1c8a9e")
  })

  it("puts every 404 under one route label, whatever path was asked for", async () => {
    observeHttpRequest("GET", "/wp-login/aaaa-bbbb", "404", 0.01)
    observeHttpRequest("GET", "/admin/zzzz-yyyy", "404", 0.01)
    const text = await (await scrape(`Bearer ${TOKEN}`)).text()
    expect(text).toContain('route="unmatched",status="404"} 2')
    expect(text).not.toContain("wp-login")
  })

  it("reports cron run outcomes", async () => {
    recordCronOutcome("dpd-update", "failed")
    const text = await (await scrape(`Bearer ${TOKEN}`)).text()
    expect(text).toContain('credaflow_cron_runs_total{job="dpd-update",outcome="failed"}')
  })

  it("reports the database as up or down", async () => {
    expect(await (await scrape(`Bearer ${TOKEN}`)).text()).toContain("credaflow_database_up 1")
    probeDatabase.mockResolvedValue({ state: "error", latencyMs: 5000 })
    expect(await (await scrape(`Bearer ${TOKEN}`)).text()).toContain("credaflow_database_up 0")
  })

  it("reports each cron job's last success and freshness budget, omitting jobs that never ran", async () => {
    heartbeats.mockResolvedValue([{ job: "/api/cron/dpd-update", lastSucceededAt: new Date("2026-10-28T03:00:00Z") }])
    const text = await (await scrape(`Bearer ${TOKEN}`)).text()
    expect(text).toContain('credaflow_cron_last_success_timestamp_seconds{job="dpd-update"} 1793156400')
    expect(text).toMatch(/credaflow_cron_freshness_budget_seconds\{job="dpd-update"\} \d+/)
    expect(text).not.toContain('credaflow_cron_last_success_timestamp_seconds{job="reminders"}')
  })

  it("still answers when a database collector throws", async () => {
    heartbeats.mockRejectedValue(new Error("connection refused"))
    const response = await scrape(`Bearer ${TOKEN}`)
    expect(response.status).toBe(200)
  })
})
