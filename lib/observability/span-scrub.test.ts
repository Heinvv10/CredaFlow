import { describe, expect, it } from "vitest"
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-node"
import { createRouteLabeler } from "./route-label"
import { scrubSpan, scrubbingExporter } from "./span-scrub"

const SERVER = 1
const CLIENT = 2

function span(name: string, attributes: Record<string, string | number>, kind?: number): ReadableSpan {
  return { name, attributes, kind, spanContext: () => ({ traceId: "t", spanId: "s", traceFlags: 1 }) } as unknown as ReadableSpan
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
    expect(event!.attributes).toEqual({ "exception.message": "fetch https://h/x failed" })
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

  it("keeps the words around a query, and a plain question", () => {
    const scrubbed = scrubSpan(
      span("x", {
        message: "did GET /a/b?token=SECRET twice; what? then (https://h/p?x=1#f) and \"/q?y=2\" done",
        question: "is this ok? yes",
      }),
    )
    expect(scrubbed.attributes.message).toBe("did GET /a/b twice; what? then (https://h/p and \"/q done")
    expect(scrubbed.attributes.question).toBe("is this ok? yes")
  })

  it.each([
    ["a key=value query after url=", "failed url=/x?token=SECRET again", "failed url=/x again"],
    ["a path inside parentheses", "fetch(/x?token=SECRET) rejected", "fetch(/x rejected"],
    ["a host with no scheme", "dialled h.example/x?token=SECRET and gave up", "dialled h.example/x and gave up"],
    ["a URL embedded in JSON", '{"url":"https://h.example/x?token=SECRET","ok":false}', '{"url":"https://h.example/x'],
    ["a fragment", "opened page#access_token=SECRET now", "opened page now"],
    ["a query that happens to end in ?", "got /a?token=SECRET? back", "got /a back"],
    ["a fragment that ends in ?", "got page#token=SECRET? back", "got page back"],
    ["a question that carries data", "is this?token=SECRET ok", "is this ok"],
    ["a bare &key=value run", "retry a=1&token=SECRET&sig=SECRET2 done", "retry a=1 done"],
  ])("fails closed on %s", (_name, input, expected) => {
    const scrubbed = scrubSpan(span("x", { m: input }))
    expect(scrubbed.attributes.m).toBe(expected)
    expect(JSON.stringify(scrubbed.attributes)).not.toContain("SECRET")
  })

  it("rewrites the path and URL attributes to the template even when the concrete path is not found", () => {
    const scrubbed = scrubSpan(
      span("GET /api/pasq-link/[token]/acknowledge", {
        "next.route": "/api/pasq-link/[token]/acknowledge",
        "http.target": "/api/pasq-link/TOKEN%2DAB/acknowledge",
        "url.path": "/api/pasq-link/TOKEN-AB/acknowledge",
        "url.full": "https://u:p@h.example:8443/api/pasq-link/TOKEN%2dab/acknowledge?x=1",
        "http.url": "not even a url TOKEN-AB",
      }),
    )
    expect(scrubbed.attributes["http.target"]).toBe("/api/pasq-link/[token]/acknowledge")
    expect(scrubbed.attributes["url.path"]).toBe("/api/pasq-link/[token]/acknowledge")
    expect(scrubbed.attributes["url.full"]).toBe("https://h.example:8443/api/pasq-link/[token]/acknowledge")
    expect(scrubbed.attributes["http.url"]).toBe("/api/pasq-link/[token]/acknowledge")
    expect(JSON.stringify(scrubbed.attributes)).not.toMatch(/TOKEN(-|%2d)AB/i)
  })

  it("catches a token written percent-encoded in one attribute and decoded in another", () => {
    const scrubbed = scrubSpan(
      span("GET /api/files/[name]", {
        "next.route": "/api/files/[name]",
        "http.target": "/api/files/a%20secret%2Fname",
        // Only the target records the path, encoded; the other layers wrote it decoded and re-encoded.
        "decoded.attribute": "opened /api/files/a secret/name",
        "reencoded.attribute": "opened /api/files/a%20secret/name",
      }),
    )
    expect(JSON.stringify(scrubbed.attributes)).not.toMatch(/secret/i)
    expect(scrubbed.attributes["decoded.attribute"]).toBe("opened /api/files/[name]")
  })

  it("overwrites a path attribute that is not a path at all, once the route is known", () => {
    const scrubbed = scrubSpan(span("x", { "next.route": "/r/[id]", "url.path": "no-leading-slash/TOKEN-XY", "http.target": "*TOKEN-XY" }))
    expect(scrubbed.attributes["url.path"]).toBe("/r/[id]")
    expect(scrubbed.attributes["http.target"]).toBe("/r/[id]")
  })

  describe("a span with no next.route (Next's middleware span)", () => {
    const manifest = {
      staticRoutes: [{ page: "/", regex: "^/(?:/)?$" }],
      dynamicRoutes: [
        { page: "/pasq/[token]", regex: "^/pasq/([^/]+?)(?:/)?$" },
        { page: "/api/pasq-link/[token]/acknowledge", regex: "^/api/pasq\\-link/([^/]+?)/acknowledge(?:/)?$" },
      ],
    }
    const middleware = (target: string) =>
      span("middleware GET", { "http.method": "GET", "http.target": target, "next.span_name": "middleware GET", "next.span_type": "Middleware.execute" })

    it("maps the raw pathname through the route labeler", () => {
      const scrubbed = scrubSpan(middleware("/pasq/Zk3-OneTimeLinkToken_9aF?src=sms"), createRouteLabeler(manifest))
      expect(scrubbed.attributes["http.target"]).toBe("/pasq/[token]")
      expect(JSON.stringify(scrubbed)).not.toContain("OneTimeLinkToken")
    })

    it("does the same for a token in the middle of the path, and in the URL attributes", () => {
      const raw = middleware("/api/pasq-link/OneTimeLinkToken/acknowledge")
      raw.attributes["url.full"] = "https://staff.lender.example/api/pasq-link/OneTimeLinkToken/acknowledge"
      const scrubbed = scrubSpan(raw, createRouteLabeler(manifest))
      expect(scrubbed.attributes["url.full"]).toBe("https://staff.lender.example/api/pasq-link/[token]/acknowledge")
      expect(JSON.stringify(scrubbed)).not.toContain("OneTimeLinkToken")
    })

    it("labels a path no route matches as unmatched, never as itself", () => {
      const scrubbed = scrubSpan(middleware("/wp-admin/Secret-Probe"), createRouteLabeler(manifest))
      expect(scrubbed.attributes["http.target"]).toBe("unmatched")
    })

    it("without a manifest falls back to the path-shape allowlist", () => {
      const scrubbed = scrubSpan(middleware("/pasq/4f3a9c1d5e7b2a60f8d4c3b2a1e0f9d8"), createRouteLabeler(null))
      expect(scrubbed.attributes["http.target"]).toBe("/pasq/:id")
    })
  })

  describe("outbound client spans (fetch to a provider)", () => {
    const manifest = {
      staticRoutes: [{ page: "/api/health", regex: "^/api/health(?:/)?$" }],
      dynamicRoutes: [{ page: "/api/loans/[id]", regex: "^/api/loans/([^/]+?)(?:/)?$" }],
    }
    const labeler = createRouteLabeler(manifest)
    const fetchSpan = (url: string, extra: Record<string, string | number> = {}) =>
      span("fetch GET " + url, { "http.url": url, "http.method": "GET", "next.span_type": "AppRender.fetch", ...extra }, CLIENT)

    it("keeps the provider's scheme, host and word-like path and drops the token", () => {
      const scrubbed = scrubSpan(fetchSpan("https://api.provider.example/v1/score/abc?access_token=SECRET#x"), labeler)
      expect(scrubbed.attributes["http.url"]).toBe("https://api.provider.example/v1/score/abc")
      expect(scrubbed.name).toBe("fetch GET https://api.provider.example/v1/score/abc")
      expect(JSON.stringify(scrubbed)).not.toContain("SECRET")
    })

    it("masks identifiers in the provider's path: a bureau ID number never leaves the process", () => {
      const url = "https://bureau.example/v1/consumers/8001015009087/report?key=SECRET"
      const scrubbed = scrubSpan(span(`fetch GET ${url}`, { "http.url": url, "url.full": url, "http.target": "/v1/consumers/8001015009087/report?key=SECRET" }, CLIENT), labeler)
      const masked = "https://bureau.example/v1/consumers/:id/report"
      expect(scrubbed.attributes["http.url"]).toBe(masked)
      expect(scrubbed.attributes["url.full"]).toBe(masked)
      expect(scrubbed.name).toBe(`fetch GET ${masked}`)
      expect(scrubbed.attributes["http.target"]).toBe("/v1/consumers/:id/report")
      expect(JSON.stringify(scrubbed)).not.toMatch(/8001015009087|SECRET/)
    })

    it.each([
      ["a phone number", "https://graph.example/v20.0/27821234567/messages", "https://graph.example/:id/:id/messages"],
      ["an email", "https://crm.example/contacts/jo@lender.example/notes", "https://crm.example/contacts/:id/notes"],
      ["a UUID", "https://p.example/loans/3f1c8a9e-1b2c-4d3e-8f90-123456789abc", "https://p.example/loans/:id"],
      ["a long opaque token", "https://p.example/links/Zk3-OneTimeLinkToken_9aF", "https://p.example/links/:id"],
      ["no path at all", "https://p.example", "https://p.example"],
    ])("masks %s in the path", (_name, url, expected) => {
      expect(scrubSpan(fetchSpan(url), labeler).attributes["http.url"]).toBe(expected)
    })

    it("does not give the provider's path an app route template, even when one would match", () => {
      const scrubbed = scrubSpan(fetchSpan("https://api.provider.example/api/loans/42?k=SECRET", { "url.full": "https://api.provider.example/api/loans/42?k=SECRET" }), labeler)
      expect(scrubbed.attributes["http.url"]).toBe("https://api.provider.example/api/loans/:id")
      expect(scrubbed.attributes["url.full"]).toBe("https://api.provider.example/api/loans/:id")
    })

    it("still removes userinfo and a header attribute", () => {
      const scrubbed = scrubSpan(fetchSpan("https://u:p@api.provider.example/v1?k=SECRET", { "http.request.header.authorization": "Bearer SECRET" }), labeler)
      expect(scrubbed.attributes["http.url"]).toBe("https://api.provider.example/v1")
      expect(JSON.stringify(scrubbed)).not.toMatch(/SECRET|u:p@/)
    })
  })

  describe("the app's own request spans (SERVER)", () => {
    const labeler = createRouteLabeler({ staticRoutes: [], dynamicRoutes: [] })

    it("joins the origin and an unmatched label with a slash", () => {
      const scrubbed = scrubSpan(span("GET /wp-admin/x", { "http.target": "/wp-admin/x", "http.url": "https://staff.lender.example/wp-admin/x?a=1" }, SERVER), labeler)
      expect(scrubbed.attributes["http.url"]).toBe("https://staff.lender.example/unmatched")
      expect(scrubbed.attributes["http.target"]).toBe("unmatched")
    })
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
