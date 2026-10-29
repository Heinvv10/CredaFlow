import { describe, expect, it } from "vitest"
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-node"
import { scrubSpan, scrubbingExporter } from "./span-scrub"

function span(name: string, attributes: Record<string, string | number>): ReadableSpan {
  return { name, attributes, spanContext: () => ({ traceId: "t", spanId: "s", traceFlags: 1 }) } as unknown as ReadableSpan
}

describe("scrubSpan", () => {
  it("strips the query string and fragment from URL attributes and the span name", () => {
    const scrubbed = scrubSpan(
      span("GET /portal/reset?token=SECRET", {
        "http.url": "https://staff.lender.example/portal/reset?token=SECRET#x",
        "url.full": "https://staff.lender.example/portal/reset?token=SECRET",
        "http.target": "/portal/reset?token=SECRET",
        "url.path": "/portal/reset",
        "url.query": "token=SECRET",
        "http.method": "GET",
      }),
    )
    expect(scrubbed.name).toBe("GET /portal/reset")
    expect(scrubbed.attributes).toEqual({
      "http.url": "https://staff.lender.example/portal/reset",
      "url.full": "https://staff.lender.example/portal/reset",
      "http.target": "/portal/reset",
      "url.path": "/portal/reset",
      "http.method": "GET",
    })
    expect(JSON.stringify(scrubbed.attributes)).not.toContain("SECRET")
  })

  it("replaces a path that carries a token with the matched route template", () => {
    const scrubbed = scrubSpan(
      span("GET /api/pasq-link/[token]/acknowledge", {
        "next.route": "/api/pasq-link/[token]/acknowledge",
        "http.target": "/api/pasq-link/4f3a9c1d5e7b2a60/acknowledge?x=1",
        "http.url": "https://h.example/api/pasq-link/4f3a9c1d5e7b2a60/acknowledge",
      }),
    )
    expect(scrubbed.attributes["http.target"]).toBe("/api/pasq-link/[token]/acknowledge")
    expect(scrubbed.attributes["http.url"]).toBe("https://h.example/api/pasq-link/[token]/acknowledge")
  })

  it("leaves the span's other behaviour (methods) intact", () => {
    expect(scrubSpan(span("x", {})).spanContext().traceId).toBe("t")
  })

  it("does not mutate the original span", () => {
    const original = span("GET /a?q=1", { "http.target": "/a?q=1" })
    scrubSpan(original)
    expect(original.attributes["http.target"]).toBe("/a?q=1")
  })
})

describe("scrubbingExporter", () => {
  it("hands the inner exporter scrubbed spans and passes shutdown/flush through", async () => {
    const seen: ReadableSpan[] = []
    let shutdowns = 0
    const inner: SpanExporter = {
      export: (spans, done) => {
        seen.push(...spans)
        done({ code: 0 })
      },
      shutdown: async () => {
        shutdowns++
      },
    }
    const exporter = scrubbingExporter(inner)
    await new Promise((resolve) => exporter.export([span("GET /a?q=1", { "http.target": "/a?q=1" })], resolve))
    expect(seen[0]!.attributes["http.target"]).toBe("/a")
    await exporter.shutdown()
    expect(shutdowns).toBe(1)
  })
})
