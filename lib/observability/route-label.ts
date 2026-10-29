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

function isRouteList(value: unknown): value is ManifestRoute[] {
  return Array.isArray(value) && value.every((route) => typeof route === "object" && route !== null && typeof route.page === "string" && typeof route.regex === "string")
}

/** The shape this module reads, and nothing it would throw on: route arrays whose regexes compile. */
function validManifest(manifest: unknown): RoutesManifest | null {
  if (typeof manifest !== "object" || manifest === null) return null
  const { staticRoutes, dynamicRoutes } = manifest as Partial<RoutesManifest>
  if (!isRouteList(staticRoutes) || !isRouteList(dynamicRoutes)) return null
  try {
    for (const route of dynamicRoutes) new RegExp(route.regex)
  } catch {
    return null
  }
  return { staticRoutes, dynamicRoutes }
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

// An API version (v1, v19.0): two digits at most per part, so a number cannot pass as one.
const VERSION = /^v\d{1,2}(\.\d{1,2})?$/

function collapseSegment(segment: string): string {
  return segment === "" || VERSION.test(segment) || isStaticSegment(segment) ? segment : ":id"
}

/**
 * A path with every segment that is not a lowercase word (digits, hex, UUIDs, tokens,
 * emails, phone numbers, anything with a capital or a dot) replaced by `:id`. For paths
 * this application has no route table for, such as a provider's.
 */
export function collapsePath(path: string): string {
  return path.split("/").map(collapseSegment).join("/")
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
export function createRouteLabeler(candidate: RoutesManifest | null): (pathname: string) => string {
  // A manifest of an unexpected shape (a Next upgrade) is no manifest: labelling runs on
  // every request and must not throw.
  const manifest = validManifest(candidate)
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
      .map(collapseSegment)
      .join("/") || "/"
    if (label.startsWith("/_next/static/")) return "/_next/static"
    if (seen.has(label)) return label
    if (seen.size >= MAX_FALLBACK_LABELS) return "other"
    seen.add(label)
    return label
  }
}

let manifestOnDisk: RoutesManifest | null | undefined

/** The build's routes manifest, read once; null when there is none or it is malformed. */
export function loadRoutesManifest(): RoutesManifest | null {
  if (manifestOnDisk !== undefined) return manifestOnDisk
  try {
    manifestOnDisk = validManifest(JSON.parse(readFileSync(path.join(process.cwd(), ".next", "routes-manifest.json"), "utf8")))
  } catch {
    // No build output here (dev server, unit tests): the path-shape fallback applies.
    manifestOnDisk = null
  }
  return manifestOnDisk
}

let labeler: ((pathname: string) => string) | undefined

/** The process's labeler, built on first use from the manifest on disk. */
export function routeLabel(pathname: string): string {
  labeler ??= createRouteLabeler(loadRoutesManifest())
  return labeler(pathname)
}
