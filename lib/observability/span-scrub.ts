import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-node"
import { createRouteLabeler, loadRoutesManifest } from "./route-label"

type Labeler = (pathname: string) => string

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

/**
 * Deny by default for anything URL-shaped. Userinfo goes first; then each
 * whitespace-delimited token that is a URL (`://`), a path (starts with `/`) or a
 * bare query (starts with `?` or `#`) is cut at its first `?` or `#`. The words around
 * it stay, so an exception message keeps its meaning; a plain word with a `?` is not
 * a URL and is left alone.
 */
function scrubValue(value: string): string {
  const unsafe = stripUserinfo(value)
  if (!/[?#]/.test(unsafe)) return unsafe
  return unsafe.replace(/\S+/g, (token) => {
    if (!/[?#]/.test(token)) return token
    const bare = token.replace(/^[("'`<[]+/, "")
    const urlShaped = bare.includes("://") || bare.startsWith("/") || (/^[?#]/.test(bare) && bare.length > 1)
    return urlShaped ? stripQuery(token) : token
  })
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/** A path, its decoded form and the re-encoded form: the same token is written differently by different layers. */
function pathVariants(path: string): string[] {
  const decoded = safeDecode(path)
  let encoded = decoded
  try {
    encoded = encodeURI(decoded)
  } catch {
    // a lone surrogate: the raw and decoded forms still cover it
  }
  return [...new Set([path, decoded, encoded])].filter((variant) => variant.length > 1)
}

/** The request paths a span names, from every path and URL attribute. */
function concretePaths(attributes: Record<string, unknown>): string[] {
  const paths: string[] = []
  for (const key of PATH_KEYS) {
    const value = attributes[key]
    if (typeof value === "string" && value.startsWith("/")) paths.push(stripQuery(value))
  }
  for (const key of FULL_URL_KEYS) {
    const value = attributes[key]
    if (typeof value !== "string") continue
    const path = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*([^?#]*)/i.exec(stripUserinfo(value))?.[1]
    if (path) paths.push(path)
    else if (value.startsWith("/")) paths.push(stripQuery(value))
  }
  return paths.filter((path) => path.length > 1)
}

interface Scrubber {
  /** Scrubs one string value. */
  value(value: string): string
  /** The attribute with the template substituted, for the path and URL keys. */
  route: string | null
}

let defaultLabeler: Labeler | undefined

/**
 * One span's scrubbing. The template is Next's `next.route` or, for spans that carry
 * none (Next's middleware span records the raw pathname), the route labeler's answer
 * for the span's path. Every occurrence of the path, raw, decoded or re-encoded, in
 * any value then becomes the template, before the generic scrub.
 */
function scrubberFor(span: ReadableSpan, labeler: Labeler): Scrubber {
  const paths = concretePaths(span.attributes)
  const named = span.attributes[ROUTE_KEY]
  const route = typeof named === "string" && named.startsWith("/") ? named : paths[0] ? labeler(paths[0]) : null
  const variants = route ? [...new Set(paths.flatMap(pathVariants))].filter((variant) => variant !== route).sort((a, b) => b.length - a.length) : []
  const replaced = (text: string) => variants.reduce((out, variant) => out.split(variant).join(route!), text)
  return { value: (text) => scrubValue(replaced(text)), route }
}

function scrubAttributes(source: Record<string, unknown> | undefined, scrub: Scrubber): Record<string, unknown> {
  const attributes: Record<string, unknown> = {}
  for (const [key, raw] of Object.entries(source ?? {})) {
    if (DROPPED_KEYS.has(key) || HEADER_KEY.test(key)) continue
    if (Array.isArray(raw)) {
      attributes[key] = raw.map((item) => (typeof item === "string" ? scrub.value(item) : item))
    } else if (typeof raw !== "string") {
      attributes[key] = raw
    } else if (scrub.route && PATH_KEYS.includes(key)) {
      // Unconditional: whatever the concrete path looked like, it is not exported.
      attributes[key] = scrub.route
    } else if (scrub.route && FULL_URL_KEYS.includes(key)) {
      const origin = /^[a-z][a-z0-9+.-]*:\/\/[^/?#\s]*/i.exec(stripUserinfo(raw))?.[0]
      attributes[key] = `${origin ?? ""}${scrub.route}`
    } else {
      attributes[key] = scrub.value(raw)
    }
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
export function scrubSpan(span: ReadableSpan, labeler?: Labeler): ReadableSpan {
  defaultLabeler ??= createRouteLabeler(loadRoutesManifest())
  const scrub = scrubberFor(span, labeler ?? defaultLabeler)
  return Object.create(span, {
    name: { value: scrub.value(span.name), enumerable: true },
    attributes: { value: scrubAttributes(span.attributes, scrub), enumerable: true },
    // Events carry exception messages, which quote URLs; a failed span's status message does too.
    events: { value: (span.events ?? []).map((event) => ({ ...event, attributes: scrubAttributes(event.attributes, scrub) })), enumerable: true },
    links: { value: (span.links ?? []).map((link) => ({ ...link, attributes: scrubAttributes(link.attributes, scrub) })), enumerable: true },
    status: { value: span.status?.message === undefined ? span.status : { ...span.status, message: scrub.value(span.status.message) }, enumerable: true },
  }) as ReadableSpan
}

/** Wraps an exporter so every span passes through scrubSpan on its way out. */
export function scrubbingExporter(inner: SpanExporter): SpanExporter {
  return {
    export: (spans, done) => inner.export(spans.map((span) => scrubSpan(span)), done),
    shutdown: () => inner.shutdown(),
    forceFlush: inner.forceFlush ? () => inner.forceFlush!() : undefined,
  }
}
