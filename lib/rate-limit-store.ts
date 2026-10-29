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

/** Anything the database call throws is the store being unavailable; the code around it stays a bug if it throws. */
async function queryStore<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    throw new SharedStoreUnavailableError("shared rate-limit query failed", { cause: error })
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
  return async function check(namespace: string, key: string, opts: RateLimitOptions): Promise<RateLimitResult> {
    if (opts.limit <= 0) return { allowed: false, remaining: 0, retryAfterSeconds: Math.max(1, Math.ceil(opts.windowMs / 1000)) }
    const hash = keyHash(namespace, key)
    const windowSeconds = opts.windowMs / 1000
    const rows = await queryStore(() => client.$queryRaw<Row[]>`
      WITH c AS (SELECT clock_timestamp() AS t, make_interval(secs => ${windowSeconds}::double precision) AS w),
      up AS (
        INSERT INTO "RateLimitHit" ("keyHash", "hits", "expiresAt")
        SELECT ${hash}::text, ARRAY[c.t], c.t + c.w FROM c
        ON CONFLICT ("keyHash") DO UPDATE SET
          "hits" = ARRAY(SELECT x FROM unnest("RateLimitHit"."hits") x WHERE x > (SELECT t - w FROM c)) || (SELECT t FROM c),
          "expiresAt" = (SELECT t + w FROM c)
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

let appStore: ReturnType<typeof createPostgresStore> | undefined

/** The store on the application's own Prisma client, loaded on first use (callerIp-only importers never load it). */
export async function checkSharedRateLimit(namespace: string, key: string, opts: RateLimitOptions): Promise<RateLimitResult> {
  appStore ??= createPostgresStore((await import("@/lib/prisma")).prisma as unknown as RawQueryClient)
  return appStore(namespace, key, opts)
}
