/**
 * Real-Postgres proof that the rate limit is shared: two separate Prisma clients (two
 * replicas) draw on one window, concurrent calls cannot overshoot it, a refused call
 * writes nothing, and the key is not stored readable.
 *
 *   RUN_RATE_LIMIT_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/rate-limit-store.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest"
import { createPostgresStore, keyHash } from "./rate-limit-store"

const suite = process.env.RUN_RATE_LIMIT_IT === "1" ? describe : describe.skip
const replicaA = new PrismaClient()
const replicaB = new PrismaClient()
const storeA = createPostgresStore(replicaA)
const storeB = createPostgresStore(replicaB)
const fresh = () => `it-${randomUUID()}`
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

suite("shared rate limit on Postgres", () => {
  afterAll(async () => {
    // No blanket DELETE: other suites share this database and own live rows; every key here is a fresh UUID.
    await Promise.all([replicaA.$disconnect(), replicaB.$disconnect()])
  })

  it("two clients share one window: hits through A count against B", async () => {
    const key = fresh()
    const opts = { limit: 5, windowMs: 60_000 }
    for (let i = 0; i < 3; i++) expect((await storeA("login", key, opts)).allowed).toBe(true)
    expect(await storeB("login", key, opts)).toMatchObject({ allowed: true, remaining: 1 })
    expect(await storeB("login", key, opts)).toMatchObject({ allowed: true, remaining: 0 })
    const refused = await storeA("login", key, opts)
    expect(refused.allowed).toBe(false)
    expect(refused.retryAfterSeconds).toBeGreaterThan(0)
    expect(refused.retryAfterSeconds).toBeLessThanOrEqual(60)
    expect((await storeB("login", key, opts)).allowed).toBe(false)
  })

  it("never lets concurrent callers on both clients exceed the limit", async () => {
    const key = fresh()
    const opts = { limit: 10, windowMs: 60_000 }
    const results = await Promise.all(Array.from({ length: 80 }, (_, i) => (i % 2 ? storeA : storeB)("burst", key, opts)))
    expect(results.filter((r) => r.allowed)).toHaveLength(10)
    expect(results.filter((r) => !r.allowed)).toHaveLength(70)
  })

  it("does not count a refused attempt: the window reopens one window after the last accepted hit", async () => {
    const key = fresh()
    const opts = { limit: 2, windowMs: 1500 }
    await storeA("w", key, opts)
    await storeA("w", key, opts)
    for (let i = 0; i < 10; i++) expect((await storeB("w", key, opts)).allowed).toBe(false)
    await sleep(1700)
    expect((await storeB("w", key, opts)).allowed).toBe(true)
  })

  it("slides: a hit stops counting exactly when it leaves the window, not the whole bucket", async () => {
    const key = fresh()
    const opts = { limit: 2, windowMs: 2000 }
    await storeA("s", key, opts)
    await sleep(1200)
    await storeA("s", key, opts)
    expect((await storeA("s", key, opts)).allowed).toBe(false)
    await sleep(900) // first hit is 2.1 s old, second 0.9 s
    expect(await storeA("s", key, opts)).toMatchObject({ allowed: true, remaining: 0 })
    expect((await storeA("s", key, opts)).allowed).toBe(false)
  })

  it("drops hits that left the window when it appends, so a steadily used key's row stays bounded by its limit", async () => {
    const key = fresh()
    const opts = { limit: 2, windowMs: 800 }
    await storeA("b", key, opts)
    await storeA("b", key, opts)
    await sleep(1000)
    await storeA("b", key, opts)
    const rows = await replicaA.$queryRaw<{ n: number }[]>`SELECT cardinality("hits")::int AS n FROM "RateLimitHit" WHERE "keyHash" = ${keyHash("b", key)}`
    expect(rows[0]!.n).toBe(1)
  })

  it("keeps namespaces and keys apart", async () => {
    const key = fresh()
    const opts = { limit: 1, windowMs: 60_000 }
    expect((await storeA("one", key, opts)).allowed).toBe(true)
    expect((await storeA("one", key, opts)).allowed).toBe(false)
    expect((await storeA("two", key, opts)).allowed).toBe(true)
    expect((await storeA("one", fresh(), opts)).allowed).toBe(true)
  })

  it("refuses everything for a limit of 0 without touching the table", async () => {
    const key = fresh()
    expect((await storeA("z", key, { limit: 0, windowMs: 1000 })).allowed).toBe(false)
    const rows = await replicaA.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM "RateLimitHit" WHERE "keyHash" = ${keyHash("z", key)}`
    expect(rows[0]!.n).toBe(0)
  })

  it("stores a hash, never the key: an email or address is not readable in the table", async () => {
    const key = `login:email:person-${randomUUID()}@lender.invalid`
    await storeA("login", key, { limit: 3, windowMs: 60_000 })
    const rows = await replicaA.$queryRaw<{ keyHash: string }[]>`SELECT "keyHash" FROM "RateLimitHit" WHERE "keyHash" = ${keyHash("login", key)}`
    expect(rows).toHaveLength(1)
    expect(rows[0]!.keyHash).toMatch(/^[0-9a-f]{64}$/)
    const leaked = await replicaA.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM "RateLimitHit" WHERE "keyHash" LIKE '%lender.invalid%'`
    expect(leaked[0]!.n).toBe(0)
  })

  it("sets expiresAt a window ahead, on the database clock, so the cleanup cron can purge it", async () => {
    const key = fresh()
    await storeA("e", key, { limit: 3, windowMs: 120_000 })
    const rows = await replicaA.$queryRaw<{ ahead: number }[]>`SELECT extract(epoch FROM ("expiresAt" - clock_timestamp()))::float8 AS ahead FROM "RateLimitHit" WHERE "keyHash" = ${keyHash("e", key)}`
    expect(rows[0]!.ahead).toBeGreaterThan(100)
    expect(rows[0]!.ahead).toBeLessThanOrEqual(120)
  })
})

suite("checkRateLimit wired to the application's Prisma client", () => {
  beforeEach(() => {
    vi.stubEnv("RATE_LIMIT_STORE", "postgres")
  })

  it("holds the limit through the public API, in the shared table", async () => {
    // Connect the application client first: the first query pays the engine start-up, which the
    // limiter's own timeout (a deliberate production setting) would count as an outage.
    await (await import("@/lib/prisma")).prisma.$queryRaw`SELECT 1`
    const { checkRateLimit, _resetRateLimitStore } = await import("./rate-limit")
    _resetRateLimitStore()
    const key = fresh()
    const opts = { limit: 2, windowMs: 60_000 }
    expect((await checkRateLimit(key, opts)).allowed).toBe(true)
    expect((await checkRateLimit(key, opts)).allowed).toBe(true)
    expect((await checkRateLimit(key, opts)).allowed).toBe(false)
    // A second "replica" (a store on another client) sees the same window under the default namespace.
    expect((await storeB("", key, opts)).allowed).toBe(false)
  })
})
