import { createHash } from "node:crypto"
import type { RateLimitOptions, RateLimitResult } from "./rate-limit"
import { SharedStoreUnavailableError } from "./rate-limit-errors"

/** The part of a Prisma client the store uses: the application client or any other. */
export interface RawQueryClient {
  $queryRaw<T = unknown>(query: TemplateStringsArray, ...values: unknown[]): Promise<T>
}

interface Row {
  n: number | null
  retry_ms: number | null
}

/** sha256(namespace NUL key): keys name emails and addresses, which the table has no need to hold. */
export function keyHash(namespace: string, key: string): string {
  return createHash("sha256").update(namespace).update("\0").update(key).digest("hex")
}

/** Postgres SQLSTATEs for a statement that ran out of time (57014) or a lock it would not wait for (55P03). */
const TIMED_OUT_SQLSTATES = new Set(["57014", "55P03"])

/** Prisma's own timeout waiting for a free connection from the limiter's pool. */
const POOL_TIMEOUT_CODE = "P2024"

function isTimeout(error: unknown): boolean {
  const e = error as { code?: unknown; meta?: { code?: unknown } } | null
  return e?.code === POOL_TIMEOUT_CODE || (typeof e?.meta?.code === "string" && TIMED_OUT_SQLSTATES.has(e.meta.code))
}

/** Server-side cap on one limiter statement; below the limiter's own SHARED_TIMEOUT_MS (lib/rate-limit.ts). */
export const STATEMENT_TIMEOUT_MS = 1000

/** Anything the database call throws is the store being unavailable (a timeout, or an error); the code around it stays a bug if it throws. */
async function queryStore<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    const kind = isTimeout(error) ? "timeout" : "error"
    throw new SharedStoreUnavailableError(`shared rate-limit query failed (${kind})`, { cause: error, kind })
  }
}

/**
 * Sliding-window limit on the database, exact like the in-memory one and atomic
 * across replicas: one row per key holds the timestamps of its hits inside the
 * window. A single INSERT ... ON CONFLICT DO UPDATE ... WHERE takes the row lock,
 * drops hits older than the window and appends this one, unless the window already
 * holds `limit` hits. A refused attempt writes nothing (so hammering does not extend
 * the lockout) and the statement returns no row from the upsert. Every timestamp is
 * the database's own clock_timestamp(), so replicas with skewed clocks agree.
 */
export function createPostgresStore(client: RawQueryClient) {
  return async function check(namespace: string, key: string, opts: RateLimitOptions, group = namespace): Promise<RateLimitResult> {
    if (opts.limit <= 0) return { allowed: false, remaining: 0, retryAfterSeconds: Math.max(1, Math.ceil(opts.windowMs / 1000)) }
    const hash = keyHash(namespace, key)
    const windowSeconds = opts.windowMs / 1000
    const rows = await queryStore(() => client.$queryRaw<Row[]>`
      WITH c AS (SELECT clock_timestamp() AS t, make_interval(secs => ${windowSeconds}::double precision) AS w),
      up AS (
        INSERT INTO "RateLimitHit" ("keyHash", "ns", "maxHits", "hits", "expiresAt")
        SELECT ${hash}::text, ${group}::text, ${opts.limit}::int, ARRAY[c.t], c.t + c.w FROM c
        ON CONFLICT ("keyHash") DO UPDATE SET
          "hits" = ARRAY(SELECT x FROM unnest("RateLimitHit"."hits") x WHERE x > (SELECT t - w FROM c)) || (SELECT t FROM c),
          "expiresAt" = (SELECT t + w FROM c),
          "maxHits" = ${opts.limit}::int
        WHERE (SELECT count(*) FROM unnest("RateLimitHit"."hits") x WHERE x > (SELECT t - w FROM c)) < ${opts.limit}::int
        RETURNING cardinality("hits") AS n
      )
      SELECT
        (SELECT n FROM up)::int AS n,
        (SELECT extract(epoch FROM (min(x) + (SELECT w FROM c) - (SELECT t FROM c))) * 1000
           FROM "RateLimitHit" r, unnest(r."hits") x
          WHERE r."keyHash" = ${hash}::text AND x > (SELECT t - w FROM c))::float8 AS retry_ms`)
    const row = rows[0]
    if (row?.n != null) return { allowed: true, remaining: Math.max(0, opts.limit - row.n), retryAfterSeconds: 0 }
    return { allowed: false, remaining: 0, retryAfterSeconds: Math.max(1, Math.ceil((row?.retry_ms ?? 1000) / 1000)) }
  }
}

/**
 * The limiter's own connection pool. It must not share the application's: a limiter call made while the
 * application holds every connection (inside an interactive transaction, under load) would wait for one, time out
 * and count as an outage, which is how a busy portal could switch the shared limits off. The URL is the
 * application's, with a small pool and a short wait for a connection unless the URL already sets them.
 */
export function limiterDatabaseUrl(url: string): string {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return url
  }
  if (!parsed.searchParams.has("connection_limit")) parsed.searchParams.set("connection_limit", "5")
  if (!parsed.searchParams.has("pool_timeout")) parsed.searchParams.set("pool_timeout", "2")
  // A statement (a wait for a locked row included) is cancelled by the server before the limiter's own timeout fires,
  // so a stalled key fails that one call and frees its connection instead of holding it while the limiter has moved on.
  const options = parsed.searchParams.get("options") ?? ""
  if (!/statement_timeout/.test(options)) parsed.searchParams.set("options", `${options} -c statement_timeout=${STATEMENT_TIMEOUT_MS}`.trim())
  return parsed.toString()
}

const globalForLimiter = globalThis as unknown as { rateLimitStore?: ReturnType<typeof createPostgresStore> }

/** The store on the limiter's own Prisma client, made on first use (callerIp-only importers never load Prisma). */
export async function checkSharedRateLimit(namespace: string, key: string, opts: RateLimitOptions, group = namespace): Promise<RateLimitResult> {
  if (!globalForLimiter.rateLimitStore) {
    const url = process.env.DATABASE_URL?.trim()
    if (!url) throw new SharedStoreUnavailableError("DATABASE_URL is not set")
    const { PrismaClient } = await import("@prisma/client")
    // A plain client: the tenant-scope and RLS hooks of lib/prisma.ts have nothing to do with this table.
    globalForLimiter.rateLimitStore = createPostgresStore(new PrismaClient({ datasourceUrl: limiterDatabaseUrl(url) }) as unknown as RawQueryClient)
  }
  return globalForLimiter.rateLimitStore(namespace, key, opts, group)
}
