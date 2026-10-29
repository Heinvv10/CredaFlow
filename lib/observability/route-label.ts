import { readFileSync } from "node:fs"
import path from "node:path"

export const UNMATCHED = "unmatched"

interface ManifestRoute {
  page: string
  regex: string
}

export interface RoutesManifest {
  staticRoutes: ManifestRoute[]
  dynamicRoutes: ManifestRoute[]
}

// Without a manifest the label is built from the path; this bounds how many it may mint.
const MAX_FALLBACK_LABELS = 1000

const SEGMENT = /^[a-z][a-z0-9-]{0,40}$/
const LONG_HEX = /^[0-9a-f]{8,}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** A segment that looks like a name (cron route, resource) and not like an identifier. */
function isStaticSegment(segment: string): boolean {
  if (!SEGMENT.test(segment) || LONG_HEX.test(segment) || UUID.test(segment)) return false
  if ((segment.match(/\d/g)?.length ?? 0) >= 3) return false
  return !(segment.length >= 20 && /\d/.test(segment) && !segment.includes("-"))
}

function stripQuery(pathname: string): string {
  const clean = pathname.split("?")[0] ?? "/"
  return clean.length > 1 ? clean.replace(/\/+$/, "") || "/" : clean
}

/**
 * Maps a request path to the `route` label of the HTTP metrics.
 *
 * With Next's routes manifest (`.next/routes-manifest.json`, which the standalone
 * image ships) the label is the matched route template, `/api/loans/[id]/statement`,
 * and any path no route matches is `unmatched`: the label set is the app's route
 * table, whatever a scanner sends. Without it (dev, tests) a segment is kept only
 * if it reads as a name, else it becomes `:id`, and at most MAX_FALLBACK_LABELS
 * labels are minted before the rest are `other`.
 */
export function createRouteLabeler(manifest: RoutesManifest | null): (pathname: string) => string {
  if (manifest) {
    const exact = new Map(manifest.staticRoutes.map((route) => [route.page, route.page]))
    const dynamic = manifest.dynamicRoutes.map((route) => ({ page: route.page, regex: new RegExp(route.regex) }))
    return (pathname) => {
      const clean = stripQuery(pathname)
      if (clean.startsWith("/_next/static/")) return "/_next/static"
      return exact.get(clean) ?? dynamic.find((route) => route.regex.test(clean))?.page ?? UNMATCHED
    }
  }
  const seen = new Set<string>()
  return (pathname) => {
    const label = stripQuery(pathname)
      .split("/")
      .map((segment) => (segment === "" || isStaticSegment(segment) ? segment : ":id"))
      .join("/") || "/"
    if (label.startsWith("/_next/static/")) return "/_next/static"
    if (seen.has(label)) return label
    if (seen.size >= MAX_FALLBACK_LABELS) return "other"
    seen.add(label)
    return label
  }
}

function readManifest(): RoutesManifest | null {
  try {
    return JSON.parse(readFileSync(path.join(process.cwd(), ".next", "routes-manifest.json"), "utf8")) as RoutesManifest
  } catch {
    // No build output here (dev server, unit tests): the path-shape fallback applies.
    return null
  }
}

let labeler: ((pathname: string) => string) | undefined

/** The process's labeler, built on first use from the manifest on disk. */
export function routeLabel(pathname: string): string {
  labeler ??= createRouteLabeler(readManifest())
  return labeler(pathname)
}
