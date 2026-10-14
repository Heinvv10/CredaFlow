import { apiError } from "@/lib/lender-api/handler"

/**
 * Cursor pagination for /api/v1 list routes: newest first, `?limit=` (1-200,
 * default 50) and `?cursor=<id of the last item of the previous page>`.
 */
export const DEFAULT_PAGE_SIZE = 50
export const MAX_PAGE_SIZE = 200
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

export interface PageParams {
  limit: number
  cursor: string | null
}

export function parsePageParams(url: URL): PageParams | Response {
  const rawLimit = url.searchParams.get("limit")
  const limit = rawLimit === null ? DEFAULT_PAGE_SIZE : Number(rawLimit)
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
    return apiError(400, "invalid_parameter", `limit must be an integer from 1 to ${MAX_PAGE_SIZE}.`)
  }
  const cursor = url.searchParams.get("cursor")
  if (cursor !== null && !ID_PATTERN.test(cursor)) return apiError(400, "invalid_parameter", "cursor is not valid.")
  return { limit, cursor }
}

/** Prisma arguments for one page (one extra row tells whether another page follows). */
export function pageQuery(p: PageParams) {
  return {
    take: p.limit + 1,
    ...(p.cursor ? { cursor: { id: p.cursor }, skip: 1 } : {}),
    orderBy: [{ createdAt: "desc" as const }, { id: "desc" as const }],
  }
}

export function pageOf<T extends { id: string }, R>(rows: T[], p: PageParams, map: (row: T) => R) {
  const page = rows.slice(0, p.limit)
  return {
    data: page.map(map),
    nextCursor: rows.length > p.limit ? page[page.length - 1].id : null,
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
