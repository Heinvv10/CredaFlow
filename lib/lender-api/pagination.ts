import { apiError } from "@/lib/lender-api/handler"

/**
 * Keyset pagination for /api/v1 list routes: newest first, `?limit=` (1-200,
 * default 50) and `?cursor=` (the nextCursor of the previous page).
 *
 * The cursor carries the last row's own (createdAt, id) and becomes a plain
 * filter on the caller's rows. It never looks a row up by id: a Prisma
 * `cursor: { id }` reads the named row WITHOUT the tenant filter to find its
 * position, so a cursor naming another lender's row would leak where that
 * row's creation time falls among this lender's rows.
 */
export const DEFAULT_PAGE_SIZE = 50
export const MAX_PAGE_SIZE = 200
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

export interface PageParams {
  limit: number
  after: { createdAt: Date; id: string } | null
}

export function encodeCursor(row: { createdAt: Date; id: string }): string {
  return Buffer.from(`${row.createdAt.toISOString()}|${row.id}`, "utf8").toString("base64url")
}

function decodeCursor(cursor: string): PageParams["after"] {
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(cursor)) return null
  const [iso, id, extra] = Buffer.from(cursor, "base64url").toString("utf8").split("|")
  const createdAt = new Date(iso ?? "")
  if (extra !== undefined || !id || !ID_PATTERN.test(id) || Number.isNaN(createdAt.getTime())) return null
  return { createdAt, id }
}

export function parsePageParams(url: URL): PageParams | Response {
  const rawLimit = url.searchParams.get("limit")
  const limit = rawLimit === null ? DEFAULT_PAGE_SIZE : Number(rawLimit)
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
    return apiError(400, "invalid_parameter", `limit must be an integer from 1 to ${MAX_PAGE_SIZE}.`)
  }
  const cursor = url.searchParams.get("cursor")
  if (cursor === null) return { limit, after: null }
  const after = decodeCursor(cursor)
  return after ? { limit, after } : apiError(400, "invalid_parameter", "cursor is not valid.")
}

/** The page's filter, to AND with the route's own `where`. */
export function pageWhere(p: PageParams) {
  if (!p.after) return {}
  const { createdAt, id } = p.after
  return { OR: [{ createdAt: { lt: createdAt } }, { createdAt, id: { lt: id } }] }
}

/** Prisma ordering and size for one page (one extra row tells whether another page follows). */
export function pageQuery(p: PageParams) {
  return {
    take: p.limit + 1,
    orderBy: [{ createdAt: "desc" as const }, { id: "desc" as const }],
  }
}

export function pageOf<T extends { id: string; createdAt: Date }, R>(rows: T[], p: PageParams, map: (row: T) => R) {
  const page = rows.slice(0, p.limit)
  return {
    data: page.map(map),
    nextCursor: rows.length > p.limit ? encodeCursor(page[page.length - 1]) : null,
  }
}

/** An optional id-shaped filter (`?clientId=`), or a 400 response. */
export function optionalIdParam(url: URL, name: string): string | null | Response {
  const value = url.searchParams.get(name)
  if (value === null) return null
  return ID_PATTERN.test(value) ? value : apiError(400, "invalid_parameter", `${name} is not valid.`)
}

/** An optional enum filter (`?status=`), or a 400 response. */
export function optionalEnumParam<T extends string>(url: URL, name: string, allowed: readonly T[]): T | null | Response {
  const value = url.searchParams.get(name)
  if (value === null) return null
  return (allowed as readonly string[]).includes(value)
    ? (value as T)
    : apiError(400, "invalid_parameter", `${name} must be one of: ${allowed.join(", ")}.`)
}

export function isIdShaped(value: string): boolean {
  return ID_PATTERN.test(value)
}
