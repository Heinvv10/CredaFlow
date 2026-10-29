import { afterEach, describe, expect, it, vi } from "vitest"
import { context, trace } from "@opentelemetry/api"
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node"
import { formatLogLine, logger } from "./logger"

const NOW = new Date("2026-10-29T12:00:00.000Z")

describe("formatLogLine", () => {
  it("is one JSON object per line with time, level, service and message", () => {
    const line = formatLogLine("info", ["[boot] APP_MODE=staff"], { now: NOW, service: "credaflow-web" })
    expect(line.endsWith("\n")).toBe(true)
    expect(JSON.parse(line)).toEqual({
      time: "2026-10-29T12:00:00.000Z",
      level: "info",
      service: "credaflow-web",
      component: "boot",
      message: "[boot] APP_MODE=staff",
    })
  })

  it("formats printf-style console arguments and keeps an Error's stack", () => {
    const parsed = JSON.parse(formatLogLine("error", ["[cron] %s failed:", "/api/cron/x", new Error("boom")], { now: NOW }))
    expect(parsed.level).toBe("error")
    expect(parsed.component).toBe("cron")
    expect(parsed.message).toContain("/api/cron/x failed:")
    expect(parsed.message).toContain("Error: boom")
  })

  it("adds trace_id and span_id of the active span", () => {
    // register() installs the async-local-storage context manager that makes a span "active".
    new NodeTracerProvider().register()
    try {
      const line = trace.getTracer("t").startActiveSpan("s", (span) => {
        const written = formatLogLine("info", ["hi"], { now: NOW })
        expect(JSON.parse(written)).toMatchObject({
          trace_id: span.spanContext().traceId,
          span_id: span.spanContext().spanId,
        })
        span.end()
        return written
      })
      expect(JSON.parse(line).trace_id).toMatch(/^[0-9a-f]{32}$/)
    } finally {
      trace.disable()
      context.disable()
    }
  })

  it("omits trace ids when there is no active span", () => {
    const parsed = JSON.parse(formatLogLine("info", ["hi"], { now: NOW }))
    expect(parsed).not.toHaveProperty("trace_id")
    expect(parsed).not.toHaveProperty("span_id")
  })
})

describe("logger", () => {
  afterEach(() => vi.restoreAllMocks())

  it("writes structured fields; warn and error go to stderr, info to stdout", () => {
    const out = vi.spyOn(process.stdout, "write").mockReturnValue(true)
    const err = vi.spyOn(process.stderr, "write").mockReturnValue(true)
    logger.info("tracing on", { endpoint: "otlp" })
    logger.warn("careful")
    expect(JSON.parse(String(out.mock.calls[0][0]))).toMatchObject({ level: "info", message: "tracing on", endpoint: "otlp" })
    expect(JSON.parse(String(err.mock.calls[0][0]))).toMatchObject({ level: "warn", message: "careful" })
  })
})
