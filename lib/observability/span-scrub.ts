import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-node"

const FULL_URL_KEYS = ["http.url", "url.full"]
const PATH_KEYS = ["http.target", "url.path"]
const DROPPED_KEYS = ["url.query"]
const ROUTE_KEY = "next.route"

function withoutQuery(value: string): string {
  return value.split(/[?#]/)[0] ?? value
}

function withPath(url: string, path: string): string {
  const match = /^([a-z][a-z0-9+.-]*:\/\/[^/?#]*)/i.exec(url)
  return match ? `${match[1]}${path}` : path
}

/**
 * A copy of the span that is safe to leave the process: query strings and fragments
 * removed from URL attributes and the name (reset and signing tokens travel in
 * them), and, when Next recorded the matched route template, that template in
 * place of the concrete path (one-time link tokens travel in path segments).
 * The original span is untouched; the copy reads through to it for everything else.
 */
export function scrubSpan(span: ReadableSpan): ReadableSpan {
  const template = span.attributes[ROUTE_KEY]
  const route = typeof template === "string" && template.startsWith("/") ? template : null
  const attributes: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(span.attributes)) {
    if (DROPPED_KEYS.includes(key)) continue
    if (typeof value !== "string") {
      attributes[key] = value
    } else if (FULL_URL_KEYS.includes(key)) {
      attributes[key] = route ? withPath(value, route) : withoutQuery(value)
    } else if (PATH_KEYS.includes(key)) {
      attributes[key] = route ?? withoutQuery(value)
    } else {
      attributes[key] = value
    }
  }
  return Object.create(span, {
    name: { value: withoutQuery(span.name), enumerable: true },
    attributes: { value: attributes, enumerable: true },
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
