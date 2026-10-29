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

  it("scrubs every string attribute, not a fixed list of keys", () => {
    const scrubbed = scrubSpan(
      span("GET /x", {
        "next.span_name": "GET /portal/reset?token=SECRET",
        "http.route": "/portal/reset?token=SECRET",
        "url.original": "/portal/reset?token=SECRET#frag",
        "some.future.attribute": "https://user:hunter2@host.example:8443/p?token=SECRET",
        "peer.address": "10.0.0.1:5432",
        "http.status_code": 200,
        "plain": "no url here",
      }),
    )
    expect(scrubbed.attributes).toEqual({
      "next.span_name": "GET /portal/reset",
      "http.route": "/portal/reset",
      "url.original": "/portal/reset",
      "some.future.attribute": "https://host.example:8443/p",
      "peer.address": "10.0.0.1:5432",
      "http.status_code": 200,
      plain: "no url here",
    })
  })

  it("scrubs string arrays", () => {
    const scrubbed = scrubSpan(span("x", { "some.list": ["/a?token=SECRET", "ok"] as unknown as string }))
    expect(scrubbed.attributes["some.list"]).toEqual(["/a", "ok"])
  })

  it("drops request and response header attributes entirely", () => {
    const scrubbed = scrubSpan(
      span("x", {
        "http.request.header.cookie": "session=SECRET",
        "http.request.header.authorization": "Bearer SECRET",
        "http.response.header.set-cookie": "session=SECRET",
        "http.request.header_names": 1,
        "http.method": "GET",
      }),
    )
    expect(Object.keys(scrubbed.attributes)).toEqual(["http.request.header_names", "http.method"])
  })

  it("scrubs the attributes of span events (exception messages quote URLs)", () => {
    const withEvent = { ...span("x", {}), events: [{ name: "exception", time: [0, 0], attributes: { "exception.message": "fetch https://u:p@h/x?token=SECRET failed" } }] } as unknown as ReadableSpan
    const [event] = scrubSpan(withEvent).events
    expect(event!.attributes).toEqual({ "exception.message": "fetch https://h/x" })
  })

  it("replaces the concrete path with the route template in every string value and the span name", () => {
    const path = "/api/pasq-link/4f3a9c1d5e7b2a60/acknowledge"
    const scrubbed = scrubSpan(
      span(`POST ${path}`, {
        "next.route": "/api/pasq-link/[token]/acknowledge",
        "http.target": `${path}?x=1`,
        "next.span_name": `POST ${path}`,
        "some.future.attribute": `handler for ${path} failed`,
        "http.url": `https://h.example${path}`,
      }),
    )
    expect(scrubbed.name).toBe("POST /api/pasq-link/[token]/acknowledge")
    expect(scrubbed.attributes["next.span_name"]).toBe("POST /api/pasq-link/[token]/acknowledge")
    expect(scrubbed.attributes["some.future.attribute"]).toBe("handler for /api/pasq-link/[token]/acknowledge failed")
    expect(JSON.stringify(scrubbed)).not.toContain("4f3a9c1d5e7b2a60")
  })

  it.each([
    ["https://u:p@ss?x@host/path", "https://host/path"],
    ["https://user:pa?ss@host/path?q=1", "https://host/path"],
    ["https://u:p@host?email=a@b.example", "https://b.example"],
    ["https://u:p@host#frag@x", "https://x"],
    ["postgres://app:s3cret@db.internal:5432/credaflow?sslmode=require", "postgres://db.internal:5432/credaflow"],
    ["see https://u:p@host/p for details", "see https://host/p for details"],
  ])("removes userinfo before the query, whatever it contains: %s", (input, expected) => {
    const scrubbed = scrubSpan(span("x", { a: input }))
    expect(scrubbed.attributes.a).toBe(expected)
    expect(JSON.stringify(scrubbed.attributes)).not.toMatch(/s3cret|u:p@|user:pa/)
  })

  it("serialised whole, an exported span holds no secret anywhere", () => {
    const full = {
      ...span("GET /r?token=SECRET", {
        "next.route": "/r",
        "http.target": "/r?token=SECRET",
        "http.request.header.cookie": "SECRET",
        "x.y": "https://u:SECRET@h/p?q=SECRET",
      }),
      status: { code: 2, message: "failed calling https://u:SECRET@h/p?q=SECRET" },
      events: [{ name: "exception", time: [0, 0], attributes: { "exception.message": "boom ?token=SECRET" } }],
      links: [{ context: { traceId: "t", spanId: "s", traceFlags: 1 }, attributes: { "link.url": "/r?token=SECRET", "http.request.header.cookie": "SECRET" } }],
    } as unknown as ReadableSpan
    const out = JSON.stringify(scrubSpan(full), (_key, value) => value)
    const flat = JSON.stringify({ name: scrubSpan(full).name, attributes: scrubSpan(full).attributes, status: scrubSpan(full).status, events: scrubSpan(full).events, links: scrubSpan(full).links })
    expect(flat).not.toContain("SECRET")
    expect(out).not.toContain("SECRET")
    expect(scrubSpan(full).status.code).toBe(2)
    expect(scrubSpan(full).status.message).toBe("failed calling https://h/p")
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
  it("passes nothing secret to the inner exporter, whatever the attribute is called", async () => {
    const seen: string[] = []
    const inner: SpanExporter = {
      export: (spans, done) => {
        seen.push(JSON.stringify(spans.map((s) => ({ name: s.name, attributes: s.attributes }))))
        done({ code: 0 })
      },
      shutdown: async () => {},
    }
    await new Promise((resolve) =>
      scrubbingExporter(inner).export(
        [span("GET /r?token=SECRET", { "next.span_name": "GET /r?token=SECRET", "http.request.header.cookie": "SECRET", "x.y": "https://u:SECRET@h/p?q=SECRET" })],
        resolve,
      ),
    )
    expect(seen.join("")).not.toContain("SECRET")
  })

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
