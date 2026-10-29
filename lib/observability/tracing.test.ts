import http from "node:http"
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, it, vi } from "vitest"
import { trace } from "@opentelemetry/api"
import { startTracing, tracingEnabled } from "./tracing"

describe("tracingEnabled", () => {
  it("is off unless an OTLP endpoint is configured", () => {
    expect(tracingEnabled({})).toBe(false)
    expect(tracingEnabled({ OTEL_EXPORTER_OTLP_ENDPOINT: "  " })).toBe(false)
    expect(tracingEnabled({ OTEL_SDK_DISABLED: "true", OTEL_EXPORTER_OTLP_ENDPOINT: "http://otel:4318" })).toBe(false)
  })

  it.each([["OTEL_EXPORTER_OTLP_ENDPOINT"], ["OTEL_EXPORTER_OTLP_TRACES_ENDPOINT"]])("is on when %s is set", (name) => {
    expect(tracingEnabled({ [name]: "http://otel:4318" })).toBe(true)
  })
})

describe("startTracing", () => {
  let handle: Awaited<ReturnType<typeof startTracing>> = null
  afterEach(async () => {
    await handle?.shutdown()
    handle = null
    trace.disable()
    vi.unstubAllEnvs()
  })

  it("does nothing, and loads no SDK, when unset", async () => {
    handle = await startTracing({})
    expect(handle).toBeNull()
    expect(trace.getTracer("t").startSpan("s").spanContext().traceId).toBe("00000000000000000000000000000000")
  })

  it("registers a provider that produces real trace ids when an endpoint is set", async () => {
    // The exporter reads the endpoint from process.env itself. The span is never
    // ended, so nothing is exported to the unreachable endpoint.
    vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://127.0.0.1:9")
    vi.stubEnv("OTEL_SERVICE_NAME", "credaflow-test")
    handle = await startTracing(process.env)
    expect(handle).not.toBeNull()
    const span = trace.getTracer("t").startSpan("s")
    expect(span.spanContext().traceId).toMatch(/^[0-9a-f]{32}$/)
    expect(span.spanContext().traceId).not.toBe("00000000000000000000000000000000")
  })

  it("exports spans without query strings: the wiring goes through the scrubbing exporter", async () => {
    const bodies: string[] = []
    const sink = http.createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on("data", (chunk: Buffer) => chunks.push(chunk))
      req.on("end", () => {
        bodies.push(Buffer.concat(chunks).toString("utf8"))
        res.end("{}")
      })
    })
    await new Promise<void>((resolve) => sink.listen(0, "127.0.0.1", resolve))
    try {
      vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", `http://127.0.0.1:${(sink.address() as AddressInfo).port}`)
      handle = await startTracing(process.env)
      const span = trace.getTracer("t").startSpan("GET /portal/reset?token=SECRET-TOKEN-VALUE", {
        attributes: { "http.target": "/portal/reset?token=SECRET-TOKEN-VALUE" },
      })
      span.end()
      await handle!.shutdown()
      handle = null
      expect(bodies.length).toBeGreaterThan(0)
      expect(bodies.join("")).toContain("/portal/reset")
      expect(bodies.join("")).not.toContain("SECRET-TOKEN-VALUE")
    } finally {
      await new Promise((resolve) => sink.close(resolve))
    }
  })
})
