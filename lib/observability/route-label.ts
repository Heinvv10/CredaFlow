const MAX_ROUTES = 500
const seen = new Set<string>()

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const NUMERIC = /^\d+$/
// Long opaque tokens: hex digests, one-time link tokens, cuid/nanoid-style ids.
const LONG_TOKEN = /^[A-Za-z0-9_-]{20,}$/

function collapse(segment: string): string {
  return UUID.test(segment) || NUMERIC.test(segment) || LONG_TOKEN.test(segment) ? ":id" : segment
}

/**
 * The `route` label of the HTTP metrics: the path with ids collapsed, so
 * /api/loans/<uuid>/statement is one series. Next's static assets collapse to
 * their directory. Label cardinality is the thing that kills a Prometheus: once
 * MAX_ROUTES distinct labels exist, any new one is "other", so a scanner
 * walking random URLs cannot grow it.
 */
export function routeLabel(pathname: string): string {
  const path = pathname.split("?")[0] ?? "/"
  let label: string
  if (path.startsWith("/_next/static/")) label = "/_next/static"
  else label = path.split("/").map(collapse).join("/") || "/"
  if (seen.has(label)) return label
  if (seen.size >= MAX_ROUTES) return "other"
  seen.add(label)
  return label
}
