import { createHash } from "node:crypto"
import type { RateLimitOptions, RateLimitResult } from "./rate-limit"
import { SharedStoreUnavailableError } from "./rate-limit-errors"
import { sealCeiling as configuredSealCeiling } from "./rate-limit-cleanup"
import { isAuthGroup } from "./rate-limit-groups"

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

function failureKind(error: unknown): "timeout" | "saturated" | "error" {
  const e = error as { code?: unknown; meta?: { code?: unknown } } | null
  if (e?.code === POOL_TIMEOUT_CODE) return "saturated"
  return typeof e?.meta?.code === "string" && TIMED_OUT_SQLSTATES.has(e.meta.code) ? "timeout" : "error"
}

/** What a caller is told to wait when its key was refused because its group is sealed. */
const SEALED_RETRY_SECONDS = 300

/**
 * New keys one address (a /64 or an IPv4 address) may create per window in a sealed group: 1/5 of the 30 sign-ins an
 * address is allowed in the same window, so a flood of made-up emails from one address cannot grow the group, while a
 * real user at that address can still start their own.
 */
export const NEW_KEYS_PER_ADDRESS = 6

/** Server-side cap on one limiter statement; below the limiter's own SHARED_TIMEOUT_MS (lib/rate-limit.ts). */
export const STATEMENT_TIMEOUT_MS = 1000
/** Server-side cap on waiting for one row lock. */
export const LOCK_TIMEOUT_MS = 800

/** Anything the database call throws is the store being unavailable (a timeout, or an error); the code around it stays a bug if it throws. */
async function queryStore<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    const kind = failureKind(error)
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
export interface StoreOptions {
  /** Rows at which a sealed group stays sealed (the cleanup's ceiling). */
  sealCeiling?: number
  /** Least time between two checks, per group and process, of whether a sealed group may be unsealed. */
  healEveryMs?: number
  /** Off only for tests of the refusal itself. */
  selfHeal?: boolean
}

export function createPostgresStore(client: RawQueryClient, options: StoreOptions = {}) {
  const healEveryMs = options.healEveryMs ?? 60_000
  const lastHeal = new Map<string, number>()

  /**
   * A call refused because its group is sealed re-checks, at most once per minute per group per process, whether the group
   * is back under the ceiling (live rows only), and lifts the seal if so: it need not wait for the cleanup job's next
   * run. Returns whether the seal was lifted.
   */
  async function healSeal(group: string): Promise<boolean> {
    const now = Date.now()
    if (now - (lastHeal.get(group) ?? -Infinity) < healEveryMs) return false
    lastHeal.set(group, now)
    const rows = await queryStore(() => client.$queryRaw<Array<{ lifted: number }>>`
      WITH live AS (SELECT count(*) AS n FROM "RateLimitHit" WHERE "ns" = ${group}::text AND "expiresAt" > now()),
      gone AS (
        DELETE FROM "RateLimitSealedGroup" WHERE "ns" = ${group}::text AND (SELECT n FROM live) < ${options.sealCeiling ?? configuredSealCeiling()}::int RETURNING 1
      )
      SELECT (SELECT count(*) FROM gone)::int AS lifted`)
    return (rows[0]?.lifted ?? 0) > 0
  }

  type Attempt = { result: RateLimitResult; sealedNoRow: boolean }

  /** One upsert. `sealedNoRow`: the key had no row and its group is sealed, so nothing was recorded. */
  async function attempt(hash: string, group: string, opts: RateLimitOptions, bypassSeal: boolean): Promise<Attempt> {
    const windowSeconds = opts.windowMs / 1000
    const rows = await queryStore(() => client.$queryRaw<Row[]>`
      WITH c AS (SELECT clock_timestamp() AS t, make_interval(secs => ${windowSeconds}::double precision) AS w),
      up AS (
        INSERT INTO "RateLimitHit" ("keyHash", "ns", "maxHits", "hits", "expiresAt")
        SELECT ${hash}::text, ${group}::text, ${opts.limit}::int, ARRAY[c.t], c.t + c.w FROM c
        -- A sealed group (past its hard row ceiling) takes no new key unless the caller has the budget to create one
        -- (bypassSeal): an existing key still reaches the conflict below.
        WHERE ${bypassSeal}::boolean
           OR NOT EXISTS (SELECT 1 FROM "RateLimitSealedGroup" sealed WHERE sealed."ns" = ${group}::text)
           OR EXISTS (SELECT 1 FROM "RateLimitHit" present WHERE present."keyHash" = ${hash}::text)
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
    if (row?.n != null) return { result: { allowed: true, remaining: Math.max(0, opts.limit - row.n), retryAfterSeconds: 0 }, sealedNoRow: false }
    // No count and no wait: the key had no row and its group is sealed.
    if (row?.retry_ms == null) return { result: { allowed: false, remaining: 0, retryAfterSeconds: SEALED_RETRY_SECONDS }, sealedNoRow: true }
    return { result: { allowed: false, remaining: 0, retryAfterSeconds: Math.max(1, Math.ceil(row.retry_ms / 1000)) }, sealedNoRow: false }
  }

  /**
   * `newKeyAddress`: for a key the caller chooses, the caller's address bucket. In a sealed group a key with no row is
   * created only if that address still has budget for new keys (NEW_KEYS_PER_ADDRESS per window, spent on its own row
   * in the "sealed-new:" group); otherwise it is refused. Keys that have a row are decided as ever.
   */
  return async function check(namespace: string, key: string, opts: RateLimitOptions, group = namespace, newKeyAddress?: string): Promise<RateLimitResult> {
    if (opts.limit <= 0) return { allowed: false, remaining: 0, retryAfterSeconds: Math.max(1, Math.ceil(opts.windowMs / 1000)) }
    const hash = keyHash(namespace, key)
    let first = await attempt(hash, group, opts, false)
    if (first.sealedNoRow && options.selfHeal !== false && (await healSeal(group))) first = await attempt(hash, group, opts, false)
    if (!first.sealedNoRow || !newKeyAddress) return first.result
    const budget = await attempt(keyHash("", `sealed-new:${group}:${newKeyAddress}`), "sealed-new:", { limit: NEW_KEYS_PER_ADDRESS, windowMs: opts.windowMs }, false)
    if (!budget.result.allowed) return first.result
    return (await attempt(hash, group, opts, true)).result
  }
}

/**
 * The limiter's own connection pools, not the application's: a limiter call made while the application holds every
 * connection (inside an interactive transaction, under load) would wait for one, time out and look like an outage.
 * Two of them, so that traffic on the ordinary limits (a flood of form posts) cannot take the connections the
 * authentication limits need: sign-in has its own. Each waits for a connection for 1 s (under the limiter's own
 * 1.5 s timeout); a call that finds its pool full is refused (authentication) or decided in memory (any other) for that
 * call alone: the congestion is local, not an outage.
 */
const POOL_SIZE = { auth: 5, other: 3 } as const

export function limiterDatabaseUrl(url: string, connections: number = POOL_SIZE.other): string {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return url
  }
  if (!parsed.searchParams.has("connection_limit")) parsed.searchParams.set("connection_limit", String(connections))
  if (!parsed.searchParams.has("pool_timeout")) parsed.searchParams.set("pool_timeout", "1")
  // A wait for a locked row gives up after LOCK_TIMEOUT_MS, and any statement after STATEMENT_TIMEOUT_MS, both server-side
  // and before the limiter's own timeout: a stalled key fails that one call and frees its connection instead of holding
  // it while the limiter has moved on.
  let options = parsed.searchParams.get("options") ?? ""
  if (!/lock_timeout/.test(options)) options = `${options} -c lock_timeout=${LOCK_TIMEOUT_MS}`.trim()
  if (!/statement_timeout/.test(options)) options = `${options} -c statement_timeout=${STATEMENT_TIMEOUT_MS}`.trim()
  parsed.searchParams.set("options", options)
  return parsed.toString()
}

const globalForLimiter = globalThis as unknown as { rateLimitStores?: Partial<Record<"auth" | "other", ReturnType<typeof createPostgresStore>>> }

/** The store on the limiter's own Prisma client for `group`'s pool, made on first use (callerIp-only importers never load Prisma). */
export async function checkSharedRateLimit(namespace: string, key: string, opts: RateLimitOptions, group = namespace, newKeyAddress?: string): Promise<RateLimitResult> {
  const pool = isAuthGroup(group) ? "auth" : "other"
  const stores = (globalForLimiter.rateLimitStores ??= {})
  if (!stores[pool]) {
    const url = process.env.DATABASE_URL?.trim()
    if (!url) throw new SharedStoreUnavailableError("DATABASE_URL is not set")
    const { PrismaClient } = await import("@prisma/client")
    // A plain client: the tenant-scope and RLS hooks of lib/prisma.ts have nothing to do with this table.
    stores[pool] = createPostgresStore(new PrismaClient({ datasourceUrl: limiterDatabaseUrl(url, POOL_SIZE[pool]) }) as unknown as RawQueryClient)
  }
  return stores[pool]!(namespace, key, opts, group, newKeyAddress)
}
