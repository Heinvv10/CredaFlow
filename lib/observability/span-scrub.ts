import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-node"

const ROUTE_KEY = "next.route"
// Attributes that hold the request path: replaced by the route template when Next recorded one.
const PATH_KEYS = new Set(["http.target", "url.path"])
const FULL_URL_KEYS = new Set(["http.url", "url.full"])
const DROPPED_KEYS = new Set(["url.query"])
const HEADER_KEY = /^http\.(request|response)\.header\./

function stripQuery(value: string): string {
  return value.split(/[?#]/)[0] ?? value
}

function stripUserinfo(value: string): string {
  return value.replace(/(:\/\/)[^/?#@\s]*@/g, "$1")
}

/** Deny by default: any string that can carry a query, fragment or credentials loses them. */
function scrubValue(value: string): string {
  if (!/[?#]|:\/\//.test(value)) return value
  return stripUserinfo(stripQuery(value))
}

function withPath(url: string, path: string): string {
  const match = /^([a-z][a-z0-9+.-]*:\/\/[^/?#]*)/i.exec(stripUserinfo(url))
  return match ? `${match[1]}${path}` : path
}

/**
 * A copy of the span that is safe to leave the process. Every string attribute and
 * the span name pass through a scrubber, not a list of known keys, because
 * attributes differ by Next and OpenTelemetry version: a value holding a `?`, `#`
 * or `://` loses its query, fragment and userinfo. Request and response header
 * attributes (cookies, authorization) are dropped. When Next recorded the matched
 * route template, it replaces the concrete path in the path and URL attributes
 * (one-time link tokens travel in path segments). The original span is untouched.
 */
export function scrubSpan(span: ReadableSpan): ReadableSpan {
  const template = span.attributes[ROUTE_KEY]
  const route = typeof template === "string" && template.startsWith("/") ? template : null
  return Object.create(span, {
    name: { value: scrubValue(span.name), enumerable: true },
    attributes: { value: scrubAttributes(span.attributes, route), enumerable: true },
    // Events carry exception messages, which quote URLs.
    events: { value: (span.events ?? []).map((event) => ({ ...event, attributes: scrubAttributes(event.attributes ?? {}, null) })), enumerable: true },
  }) as ReadableSpan
}

function scrubAttributes(source: Record<string, unknown>, route: string | null): Record<string, unknown> {
  const attributes: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(source)) {
    if (DROPPED_KEYS.has(key) || HEADER_KEY.test(key)) continue
    if (Array.isArray(value)) {
      attributes[key] = value.map((item) => (typeof item === "string" ? scrubValue(item) : item))
    } else if (typeof value !== "string") {
      attributes[key] = value
    } else if (route && FULL_URL_KEYS.has(key)) {
      attributes[key] = withPath(value, route)
    } else if (route && PATH_KEYS.has(key)) {
      attributes[key] = route
    } else {
      attributes[key] = scrubValue(value)
    }
  }
  return attributes
}

/** Wraps an exporter so every span passes through scrubSpan on its way out. */
export function scrubbingExporter(inner: SpanExporter): SpanExporter {
  return {
    export: (spans, done) => inner.export(spans.map(scrubSpan), done),
    shutdown: () => inner.shutdown(),
    forceFlush: inner.forceFlush ? () => inner.forceFlush!() : undefined,
  }
}
