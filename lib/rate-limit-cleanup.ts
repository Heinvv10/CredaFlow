/** Housekeeping for RateLimitHit (lib/rate-limit-store.ts): expired rows, and a ceiling on each group's row count. */
import { FAIL_CLOSED_KEY_PREFIXES, FAIL_CLOSED_NAMESPACES } from "./rate-limit-groups"

interface ExecClient {
  $executeRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<number>
  $queryRaw<T = unknown>(query: TemplateStringsArray, ...values: unknown[]): Promise<T>
}

/**
 * Most rows one group may hold before the cleanup starts evicting the rows that are not lockouts. A group's rows are one
 * per distinct key, and a key can be chosen by the caller (an email address typed into a login form). Generous next to
 * any real population of limited keys.
 */
export const MAX_ROWS_PER_GROUP = 200_000

/**
 * The second, higher ceiling, a multiple of the first: beyond it even lockouts are evicted (the ones expiring soonest),
 * because a table that grows without bound hurts every limit and a flood that fills it with lockouts is bounded only
 * this way. Each such eviction is an alert (the route logs it).
 */
export const HARD_CEILING_MULTIPLIER = 5

const AUTH_GROUPS: readonly string[] = [...FAIL_CLOSED_KEY_PREFIXES, ...FAIL_CLOSED_NAMESPACES]

/** Rows whose window has passed hold no hit that still counts: deleting them changes no decision. */
export async function purgeExpired(db: ExecClient): Promise<number> {
  return db.$executeRaw`DELETE FROM "RateLimitHit" WHERE "expiresAt" < now()`
}

export interface CapOptions {
  cap?: number
  hardCeiling?: number
  /** Limits the cleanup to those groups (suites sharing a database). */
  onlyGroups?: readonly string[]
}

export interface CapResult {
  /** Rows deleted above `cap`: the least recently used ones that were not lockouts. */
  evicted: number
  /** Rows deleted above `hardCeiling`, lockouts included, per group. Each is an alert. */
  hardEvicted: GroupSize[]
}

export interface GroupSize {
  ns: string
  rows: number
}

/**
 * Bounds the ordinary groups. An authentication group is never touched here: every row in it with a hit inside its window
 * is an active counter or a lockout, and evicting one lifts it (see sealOverfullAuthGroups for how those are bounded).
 * A group over `cap` rows loses the rows that expire soonest (the least recently used keys), down to `cap`, but only rows
 * that do NOT still hold a full window. If a group is still over `hardCeiling` (a flood of lockouts), the rows expiring
 * soonest are evicted whatever they hold, and reported.
 */
export async function capRowsPerGroup(db: ExecClient, options: CapOptions = {}): Promise<CapResult> {
  const cap = options.cap ?? MAX_ROWS_PER_GROUP
  const hardCeiling = options.hardCeiling ?? cap * HARD_CEILING_MULTIPLIER
  const groups = options.onlyGroups ?? null
  const evicted = await db.$executeRaw`
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
  const hard = await db.$queryRaw<Array<{ ns: string; rows: number }>>`
    WITH ranked AS (
      SELECT "keyHash", "ns",
             row_number() OVER (PARTITION BY "ns" ORDER BY "expiresAt", "keyHash") AS rn,
             count(*) OVER (PARTITION BY "ns") AS total
      FROM "RateLimitHit"
      WHERE NOT ("ns" = ANY(${AUTH_GROUPS}::text[]))
        AND (${groups}::text[] IS NULL OR "ns" = ANY(${groups}::text[]))
    ), removed AS (
      DELETE FROM "RateLimitHit" WHERE "keyHash" IN (SELECT "keyHash" FROM ranked WHERE rn <= total - ${hardCeiling}::int)
      RETURNING "ns"
    )
    SELECT "ns", count(*)::int AS rows FROM removed GROUP BY "ns" ORDER BY 2 DESC`
  return { evicted, hardEvicted: hard.map((r) => ({ ns: r.ns, rows: Number(r.rows) })) }
}

/** Groups holding more than `cap` rows now: after the cleanup these are the ones whose excess is all lockouts. */
export async function groupsOverCap(db: ExecClient, cap = MAX_ROWS_PER_GROUP): Promise<GroupSize[]> {
  const rows = await db.$queryRaw<Array<{ ns: string; rows: bigint }>>`
    SELECT "ns", count(*) AS rows FROM "RateLimitHit" GROUP BY "ns" HAVING count(*) > ${cap}::int ORDER BY 2 DESC`
  return rows.map((r) => ({ ns: r.ns, rows: Number(r.rows) }))
}

/**
 * Bounds the authentication groups without ever deleting a counter or a lockout: a group that holds `hardCeiling` rows or
 * more is SEALED (RateLimitSealedGroup): the store takes no new key in it, so a flood of made-up keys cannot grow it
 * further, while every key that has a row keeps counting and a lockout stays locked out. A sealed group that is back
 * under the ceiling (rows expire on their own) is unsealed. Returns the groups sealed now, with their row counts; the
 * route raises an alert for each, every run.
 */
export async function sealOverfullAuthGroups(db: ExecClient, hardCeiling = MAX_ROWS_PER_GROUP * HARD_CEILING_MULTIPLIER): Promise<GroupSize[]> {
  await db.$executeRaw`
    INSERT INTO "RateLimitSealedGroup" ("ns")
    SELECT "ns" FROM "RateLimitHit" WHERE "ns" = ANY(${AUTH_GROUPS}::text[]) GROUP BY "ns" HAVING count(*) >= ${hardCeiling}::int
    ON CONFLICT ("ns") DO NOTHING`
  await db.$executeRaw`
    DELETE FROM "RateLimitSealedGroup" WHERE "ns" = ANY(${AUTH_GROUPS}::text[]) AND "ns" NOT IN (
      SELECT "ns" FROM "RateLimitHit" WHERE "ns" = ANY(${AUTH_GROUPS}::text[]) GROUP BY "ns" HAVING count(*) >= ${hardCeiling}::int
    )`
  const sealed = await db.$queryRaw<Array<{ ns: string; rows: number }>>`
    SELECT h."ns", count(*)::int AS rows FROM "RateLimitHit" h JOIN "RateLimitSealedGroup" s ON s."ns" = h."ns" GROUP BY h."ns" ORDER BY 2 DESC`
  return sealed.map((r) => ({ ns: r.ns, rows: Number(r.rows) }))
}
