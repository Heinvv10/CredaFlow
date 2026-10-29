/** Housekeeping for RateLimitHit (lib/rate-limit-store.ts): expired rows, and a ceiling on each group's row count. */
import { FAIL_CLOSED_KEY_PREFIXES, FAIL_CLOSED_NAMESPACES } from "./rate-limit-groups"

interface ExecClient {
  $executeRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<number>
  $queryRaw<T = unknown>(query: TemplateStringsArray, ...values: unknown[]): Promise<T>
}

/**
 * Most rows one group may hold. A group's rows are one per distinct key, and a key can be chosen by the caller (an
 * email address typed into a login form). Generous next to any real population of limited keys.
 */
export const MAX_ROWS_PER_GROUP = 200_000

const AUTH_GROUPS: readonly string[] = [...FAIL_CLOSED_KEY_PREFIXES, ...FAIL_CLOSED_NAMESPACES]

/** Rows whose window has passed hold no hit that still counts: deleting them changes no decision. */
export async function purgeExpired(db: ExecClient): Promise<number> {
  return db.$executeRaw`DELETE FROM "RateLimitHit" WHERE "expiresAt" < now()`
}

/**
 * Bounds the other groups, never an authentication one. In a group over `cap` rows it deletes the rows that expire
 * soonest (the least recently used keys), down to `cap`, but only rows that do NOT still hold a full window: a key
 * that is locked out (its hits have reached its limit and its window is open) is never evicted, or the cap would be
 * a way to lift a lockout. An authentication group (sign-in, codes, OAuth) is not evicted at all: its growth is
 * bounded by the gate order (the address bucket is checked first) and it is reported by `groupsOverCap` instead.
 * `onlyGroups` limits it to those groups (suites sharing a database). Returns the number deleted.
 */
export async function capRowsPerGroup(db: ExecClient, cap = MAX_ROWS_PER_GROUP, onlyGroups?: readonly string[]): Promise<number> {
  const groups = onlyGroups ?? null
  return db.$executeRaw`
    DELETE FROM "RateLimitHit" WHERE "keyHash" IN (
      SELECT e."keyHash" FROM (
        SELECT "keyHash", "ns",
               row_number() OVER (PARTITION BY "ns" ORDER BY "expiresAt", "keyHash") AS rn
        FROM "RateLimitHit"
        WHERE NOT (cardinality("hits") >= "maxHits" AND "maxHits" > 0 AND "expiresAt" > now())
          AND NOT ("ns" = ANY(${AUTH_GROUPS}::text[]))
          AND (${groups}::text[] IS NULL OR "ns" = ANY(${groups}::text[]))
      ) e
      JOIN (SELECT "ns", count(*) AS total FROM "RateLimitHit" GROUP BY "ns") t ON t."ns" = e."ns"
      WHERE e.rn <= t.total - ${cap}::int
    )`
}

export interface GroupSize {
  ns: string
  rows: number
}

/** Groups holding more than `cap` rows: for an authentication group that is an alert, since nothing evicts it. */
export async function groupsOverCap(db: ExecClient, cap = MAX_ROWS_PER_GROUP): Promise<GroupSize[]> {
  const rows = await db.$queryRaw<Array<{ ns: string; rows: bigint }>>`
    SELECT "ns", count(*) AS rows FROM "RateLimitHit" GROUP BY "ns" HAVING count(*) > ${cap}::int ORDER BY 2 DESC`
  return rows.map((r) => ({ ns: r.ns, rows: Number(r.rows) }))
}
