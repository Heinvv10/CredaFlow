import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-node"

const ROUTE_KEY = "next.route"
const PATH_KEYS = ["http.target", "url.path"]
const FULL_URL_KEYS = ["http.url", "url.full"]
const DROPPED_KEYS = new Set(["url.query"])
const HEADER_KEY = /^http\.(request|response)\.header\./

function stripQuery(value: string): string {
  return value.split(/[?#]/)[0] ?? value
}

/**
 * Everything from `://` up to the LAST `@` before the first `/` is the authority's
 * userinfo (or something that passed for it): removed whole, and before any query
 * handling, because a `?`, `#` or `@` inside the password must not end the match early.
 */
function stripUserinfo(value: string): string {
  return value.replace(/(:\/\/)[^/\s]*@/g, "$1")
}

/** Deny by default: any string that can carry a query, fragment or credentials loses them. */
function scrubValue(value: string): string {
  if (!/[?#]|:\/\//.test(value)) return value
  return stripQuery(stripUserinfo(value))
}

/** The request path the span was made for, from whichever attribute holds it. */
function concretePath(attributes: Record<string, unknown>): string | null {
  for (const key of PATH_KEYS) {
    const value = attributes[key]
    if (typeof value === "string" && value.startsWith("/")) return stripQuery(value)
  }
  for (const key of FULL_URL_KEYS) {
    const value = attributes[key]
    if (typeof value !== "string") continue
    const path = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*([^?#]*)/i.exec(stripUserinfo(value))?.[1]
    if (path) return path
  }
  return null
}

/**
 * Builds the string scrubber of one span. When Next recorded the matched route
 * template and the concrete path differs from it, every occurrence of the path in any
 * value (one-time link tokens travel in path segments) becomes the template, then
 * the generic scrub runs.
 */
function scrubber(span: ReadableSpan): (value: string) => string {
  const template = span.attributes[ROUTE_KEY]
  const route = typeof template === "string" && template.startsWith("/") ? template : null
  const path = route ? concretePath(span.attributes) : null
  const replacePath = route && path && path.length > 1 && path !== route ? (value: string) => value.split(path).join(route) : (value: string) => value
  return (value) => scrubValue(replacePath(value))
}

function scrubAttributes(source: Record<string, unknown> | undefined, scrub: (value: string) => string): Record<string, unknown> {
  const attributes: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(source ?? {})) {
    if (DROPPED_KEYS.has(key) || HEADER_KEY.test(key)) continue
    if (Array.isArray(value)) attributes[key] = value.map((item) => (typeof item === "string" ? scrub(item) : item))
    else attributes[key] = typeof value === "string" ? scrub(value) : value
  }
  return attributes
}

/**
 * A copy of the span that is safe to leave the process. Deny by default: every string
 * the span carries (name, attributes, event and link attributes, status message) passes
 * through the scrubber, not a list of known keys, because attribute names differ by Next
 * and OpenTelemetry version. Request and response header attributes (cookies,
 * authorization) are dropped. The original span is untouched.
 */
export function scrubSpan(span: ReadableSpan): ReadableSpan {
  const scrub = scrubber(span)
  return Object.create(span, {
    name: { value: scrub(span.name), enumerable: true },
    attributes: { value: scrubAttributes(span.attributes, scrub), enumerable: true },
    // Events carry exception messages, which quote URLs; a failed span's status message does too.
    events: { value: (span.events ?? []).map((event) => ({ ...event, attributes: scrubAttributes(event.attributes, scrub) })), enumerable: true },
    links: { value: (span.links ?? []).map((link) => ({ ...link, attributes: scrubAttributes(link.attributes, scrub) })), enumerable: true },
    status: { value: span.status?.message === undefined ? span.status : { ...span.status, message: scrub(span.status.message) }, enumerable: true },
  }) as ReadableSpan
}

/** Wraps an exporter so every span passes through scrubSpan on its way out. */
export function scrubbingExporter(inner: SpanExporter): SpanExporter {
  return {
    export: (spans, done) => inner.export(spans.map(scrubSpan), done),
    shutdown: () => inner.shutdown(),
    forceFlush: inner.forceFlush ? () => inner.forceFlush!() : undefined,
  }
}
