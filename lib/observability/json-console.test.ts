import { afterEach, describe, expect, it, vi } from "vitest"
import { context, trace } from "@opentelemetry/api"
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node"
import { installJsonConsole, restoreConsole } from "./json-console"

afterEach(() => {
  restoreConsole()
  vi.restoreAllMocks()
})

describe("installJsonConsole", () => {
  it("leaves console untouched unless LOG_FORMAT=json", () => {
    const before = console.log
    expect(installJsonConsole({})).toBe(false)
    expect(installJsonConsole({ LOG_FORMAT: "text" })).toBe(false)
    expect(console.log).toBe(before)
  })

  it("turns every console call into a JSON line at the matching level and stream", () => {
    const out = vi.spyOn(process.stdout, "write").mockReturnValue(true)
    const err = vi.spyOn(process.stderr, "write").mockReturnValue(true)
    expect(installJsonConsole({ LOG_FORMAT: "json", OTEL_SERVICE_NAME: "credaflow-worker" })).toBe(true)
    console.log("[cron] a ok")
    console.warn("[health] w")
    console.error("[cron] e", new Error("x"))
    const lines = [...out.mock.calls, ...err.mock.calls].map((c) => JSON.parse(String(c[0])))
    expect(lines.map((l) => l.level).sort()).toEqual(["error", "info", "warn"])
    expect(lines.every((l) => l.service === "credaflow-worker")).toBe(true)
    expect(out).toHaveBeenCalledTimes(1)
    expect(err).toHaveBeenCalledTimes(2)
  })

  it("is idempotent", () => {
    const out = vi.spyOn(process.stdout, "write").mockReturnValue(true)
    installJsonConsole({ LOG_FORMAT: "json" })
    installJsonConsole({ LOG_FORMAT: "json" })
    console.log("once")
    expect(out).toHaveBeenCalledTimes(1)
  })

  it("carries the trace and span id of the active span on the emitted line", () => {
    const out = vi.spyOn(process.stdout, "write").mockReturnValue(true)
    installJsonConsole({ LOG_FORMAT: "json" })
    new NodeTracerProvider().register()
    try {
      trace.getTracer("t").startActiveSpan("s", (span) => {
        console.log("[cron] inside a span")
        const line = JSON.parse(String(out.mock.calls[0][0]))
        expect(line.trace_id).toBe(span.spanContext().traceId)
        expect(line.span_id).toBe(span.spanContext().spanId)
        span.end()
      })
    } finally {
      trace.disable()
      context.disable()
    }
  })
})
