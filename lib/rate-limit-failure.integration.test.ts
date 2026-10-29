/**
 * Real-Postgres proof of how the limiter behaves when the shared store is slow or unreachable (PR #259 breaker
 * review): authentication limits fail CLOSED, an unrelated slow key does not move other limits off the store, a
 * transaction holding every application connection does not starve the limiter, and the cleanup caps a flooded group.
 *
 *   RUN_RATE_LIMIT_IT=1 DATABASE_URL=postgresql://... npx vitest run lib/rate-limit-failure.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest"
import { keyHash } from "./rate-limit-store"

const suite = process.env.RUN_RATE_LIMIT_IT === "1" ? describe : describe.skip
const side = new PrismaClient()
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const WINDOW = 15 * 60_000

/** Holds a key's row lock for `ms` on another connection, so the limiter's upsert on that key stalls. */
async function lockKey(namespace: string, key: string, ms: number): Promise<{ released: Promise<unknown> }> {
  const hash = keyHash(namespace, key)
  const held = side.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 FROM "RateLimitHit" WHERE "keyHash" = ${hash} FOR UPDATE`
    await sleep(ms)
  }, { timeout: ms + 10_000 })
  await sleep(150)
  // boxed: returning the promise itself would make the caller's await wait for the lock to end
  return { released: held }
}

suite("the limiter when the shared store is slow or down", () => {
  beforeEach(async () => {
    vi.stubEnv("RATE_LIMIT_STORE", "postgres")
    vi.spyOn(console, "error").mockImplementation(() => {})
    const { _resetRateLimitStore } = await import("./rate-limit")
    _resetRateLimitStore()
  })
  afterAll(async () => {
    await side.$disconnect()
  })

  it("refuses a sign-in attempt, rather than counting it from zero in memory, while the store does not answer", async () => {
    const { checkRateLimit } = await import("./rate-limit")
    const key = `login:email:${randomUUID()}@x.test`
    const opts = { limit: 10, windowMs: WINDOW }
    for (let i = 0; i < 10; i++) await checkRateLimit(key, opts)
    expect((await checkRateLimit(key, opts)).allowed).toBe(false)
    const held = await lockKey("", key, 2_500)
    const stalled = await checkRateLimit(key, opts)
    expect(stalled).toMatchObject({ allowed: false, remaining: 0 })
    expect(stalled.retryAfterSeconds).toBeGreaterThan(0)
    await held.released
  }, 30_000)

  it("refuses only the call on a key someone holds a lock on: every other login still gets its answer from the store", async () => {
    const { checkRateLimit } = await import("./rate-limit")
    const opts = { limit: 10, windowMs: WINDOW }
    const locked = `login:email:${randomUUID()}@x.test`
    const victim = `login:email:${randomUUID()}@x.test`
    await checkRateLimit(locked, opts)
    for (let i = 0; i < 10; i++) await checkRateLimit(victim, opts)
    const held = await lockKey("", locked, 6_000)
    for (let i = 0; i < 5; i++) {
      const started = Date.now()
      expect((await checkRateLimit(locked, opts)).allowed).toBe(false)
      // the server cancels the statement first (statement_timeout), well inside the limiter's own 1.5 s
      expect(Date.now() - started).toBeLessThan(1500)
    }
    // five timeouts in a row did not switch the group off: others are still decided by the store
    expect((await checkRateLimit(victim, opts)).allowed).toBe(false)
    const fresh = `login:email:${randomUUID()}@x.test`
    for (let i = 0; i < 10; i++) expect((await checkRateLimit(fresh, opts)).allowed).toBe(true)
    expect((await checkRateLimit(fresh, opts)).allowed).toBe(false)
    await held.released
  }, 40_000)

  it("keeps sign-in on the store while a flood of other limiter calls saturates the other pool", async () => {
    const { checkRateLimit } = await import("./rate-limit")
    const opts = { limit: 10, windowMs: WINDOW }
    const victim = `login:email:${randomUUID()}@x.test`
    for (let i = 0; i < 10; i++) await checkRateLimit(victim, opts)
    // Every flood call waits on the same locked row of an ordinary limit, so the small pool for ordinary limits is full.
    const slow = `website:contact:${randomUUID()}`
    await checkRateLimit(slow, { limit: 1000, windowMs: 60_000 })
    const held = await lockKey("", slow, 4_000)
    const flood = Array.from({ length: 60 }, () => checkRateLimit(slow, { limit: 1000, windowMs: 60_000 }))
    await sleep(300)
    // the flood fills the pool for ordinary limits (its 3 connections all wait on the row lock)
    const waiting = await side.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock'`
    expect(waiting[0]!.n).toBe(3)
    // while it is stuck: exhausted sign-in is still refused BY THE STORE (memory would hand out a fresh budget), fast
    const started = Date.now()
    expect((await checkRateLimit(victim, opts)).allowed).toBe(false)
    const fresh = `login:email:${randomUUID()}@x.test`
    for (let i = 0; i < 10; i++) expect((await checkRateLimit(fresh, opts)).allowed).toBe(true)
    expect((await checkRateLimit(fresh, opts)).allowed).toBe(false)
    expect(Date.now() - started).toBeLessThan(1500)
    await Promise.all(flood)
    await held.released
  }, 40_000)

  it("keeps the rest of the limits on the store when one key stalls: an exhausted sign-in key stays refused", async () => {
    const { checkRateLimit } = await import("./rate-limit")
    const victim = `login:email:${randomUUID()}@x.test`
    const opts = { limit: 10, windowMs: WINDOW }
    for (let i = 0; i < 10; i++) await checkRateLimit(victim, opts)
    const slow = `website:contact:${randomUUID()}`
    await checkRateLimit(slow, { limit: 100, windowMs: 60_000 })
    for (let round = 0; round < 3; round++) {
      const held = await lockKey("", slow, 2_200)
      await checkRateLimit(slow, { limit: 100, windowMs: 60_000 })
      await held.released
    }
    let extra = 0
    for (let i = 0; i < 20; i++) if ((await checkRateLimit(victim, opts)).allowed) extra++
    expect(extra).toBe(0)
  }, 40_000)

  it("does not let application transactions holding every connection switch the limits off", async () => {
    vi.stubEnv("DATABASE_URL", `${process.env.DATABASE_URL}${process.env.DATABASE_URL?.includes("?") ? "&" : "?"}connection_limit=2`)
    vi.resetModules()
    const { checkRateLimit } = await import("./rate-limit")
    const { prisma } = await import("@/lib/prisma")
    const victim = `login:email:${randomUUID()}@x.test`
    const opts = { limit: 10, windowMs: WINDOW }
    for (let i = 0; i < 10; i++) await checkRateLimit(victim, opts)
    // two interleaved applications, as the portal's apply route runs them: the limiter is called inside the transaction
    const apply = (id: string) => prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1`
      return checkRateLimit(`portal:apply:${id}`, { limit: 6, windowMs: 3_600_000 })
    }, { timeout: 10_000, maxWait: 10_000 })
    const results = await Promise.allSettled([apply("a"), apply("b")])
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"])
    let extra = 0
    for (let i = 0; i < 20; i++) if ((await checkRateLimit(victim, opts)).allowed) extra++
    expect(extra).toBe(0)
    await prisma.$disconnect()
  }, 40_000)

  it("answers every one of 50 parallel calls for one key exactly once, 10 allowed", async () => {
    const { checkRateLimit } = await import("./rate-limit")
    const key = `login:email:${randomUUID()}@x.test`
    const results = await Promise.all(Array.from({ length: 50 }, () => checkRateLimit(key, { limit: 10, windowMs: WINDOW })))
    expect(results.filter((r) => r.allowed)).toHaveLength(10)
  })

  it("never admits more than the limit in any window on the store (worst case over 4.5 s at 5 per 2 s, measured with 100 ms of client-side jitter)", async () => {
    const { checkRateLimit } = await import("./rate-limit")
    const key = `edge:${randomUUID()}`
    const opts = { limit: 5, windowMs: 2000 }
    const stamps: number[] = []
    const t0 = Date.now()
    while (Date.now() - t0 < 4500) {
      if ((await checkRateLimit(key, opts)).allowed) stamps.push(Date.now())
      await sleep(20)
    }
    let worst = 0
    for (const s of stamps) worst = Math.max(worst, stamps.filter((x) => x >= s && x < s + 1900).length)
    expect(worst).toBeLessThanOrEqual(5)
  }, 20_000)
})

suite("the cleanup caps a flooded group", () => {
  const rows = (ns: string, n: number, over: { maxHits?: number; hits?: number; from?: number } = {}) =>
    Array.from({ length: n }, (_, i) => ({
      keyHash: `${ns}-${i}`, ns, maxHits: over.maxHits ?? 10,
      hits: Array.from({ length: over.hits ?? 1 }, () => new Date()), expiresAt: new Date(Date.now() + ((over.from ?? 0) + i + 1) * 60_000),
    }))

  it("keeps the newest rows of a group above the cap and leaves other groups alone", async () => {
    const { capRowsPerGroup } = await import("./rate-limit-cleanup")
    const group = `flood-${randomUUID()}`
    const other = `calm-${randomUUID()}`
    await side.rateLimitHit.createMany({ data: [...rows(group, 12), ...rows(other, 3)] })
    const { evicted: removed, hardEvicted } = await capRowsPerGroup(side, { cap: 5, hardCeiling: 1000, onlyGroups: [group, other] })
    expect(removed).toBe(7)
    expect(hardEvicted).toEqual([])
    expect(await side.rateLimitHit.count({ where: { ns: group } })).toBe(5)
    expect(await side.rateLimitHit.count({ where: { ns: other } })).toBe(3)
    expect((await side.rateLimitHit.findMany({ where: { ns: group }, select: { keyHash: true } })).map((r) => r.keyHash).sort())
      .toEqual([7, 8, 9, 10, 11].map((i) => `${group}-${i}`).sort())
    await side.rateLimitHit.deleteMany({ where: { ns: { in: [group, other] } } })
  })

  it("never evicts a key that is locked out, even the one that expires soonest", async () => {
    const { capRowsPerGroup } = await import("./rate-limit-cleanup")
    const group = `flood-${randomUUID()}`
    // row 0 expires first and has used its whole limit (10 of 10): it must outlive the cap
    await side.rateLimitHit.createMany({ data: [...rows(group, 1, { hits: 10 }), ...rows(group, 11, { from: 1 }).map((r, i) => ({ ...r, keyHash: `${group}-${i + 1}` }))] })
    await capRowsPerGroup(side, { cap: 5, hardCeiling: 1000, onlyGroups: [group] })
    const left = (await side.rateLimitHit.findMany({ where: { ns: group }, select: { keyHash: true } })).map((r) => r.keyHash)
    expect(left).toContain(`${group}-0`)
    // 12 rows, cap 5: the locked-out row plus the 4 newest of the rest
    expect(left).toHaveLength(5)
    await side.rateLimitHit.deleteMany({ where: { ns: group } })
  })

  it("bounds an authentication group too: beyond the cap it evicts its rows that are not lockouts, oldest first", async () => {
    const { capRowsPerGroup } = await import("./rate-limit-cleanup")
    await side.rateLimitHit.deleteMany({ where: { ns: "login:" } })
    // 3 lockouts (10 of 10) that expire soonest, then 9 ordinary rows
    await side.rateLimitHit.createMany({ data: [...rows("login:", 3, { hits: 10 }), ...rows("login:", 9, { from: 3 }).map((r, i) => ({ ...r, keyHash: `login:-${i + 3}` }))] })
    const result = await capRowsPerGroup(side, { cap: 6, hardCeiling: 1000, onlyGroups: ["login:"] })
    expect(result.evicted).toBe(6)
    const left = (await side.rateLimitHit.findMany({ where: { ns: "login:" }, select: { keyHash: true } })).map((r) => r.keyHash).sort()
    // the three lockouts stay; of the nine ordinary rows the three that expire last stay
    expect(left).toEqual(["login:-0", "login:-1", "login:-2", "login:-9", "login:-10", "login:-11"].sort())
    await side.rateLimitHit.deleteMany({ where: { ns: "login:" } })
  })

  it("beyond the hard ceiling evicts even lockouts, the ones expiring soonest, and reports the group", async () => {
    const { capRowsPerGroup, groupsOverCap } = await import("./rate-limit-cleanup")
    const group = `flood-${randomUUID()}`
    await side.rateLimitHit.createMany({ data: rows(group, 12, { hits: 10 }) })
    const result = await capRowsPerGroup(side, { cap: 4, hardCeiling: 8, onlyGroups: [group] })
    expect(result.evicted).toBe(0) // every row is a lockout: the soft pass finds nothing to evict
    expect(result.hardEvicted).toEqual([{ ns: group, rows: 4 }])
    const left = (await side.rateLimitHit.findMany({ where: { ns: group }, select: { keyHash: true } })).map((r) => r.keyHash).sort()
    expect(left).toEqual([4, 5, 6, 7, 8, 9, 10, 11].map((i) => `${group}-${i}`).sort())
    // still over the first ceiling, all lockouts: reported
    expect(await groupsOverCap(side, 4)).toContainEqual({ ns: group, rows: 8 })
    await side.rateLimitHit.deleteMany({ where: { ns: group } })
  })

  it("leaves a locked-out key locked out through the whole cleanup, and the limiter still refuses it afterwards", async () => {
    vi.stubEnv("RATE_LIMIT_STORE", "postgres")
    const { checkRateLimit, _resetRateLimitStore } = await import("./rate-limit")
    const { capRowsPerGroup } = await import("./rate-limit-cleanup")
    _resetRateLimitStore()
    const key = `website:contact:${randomUUID()}`
    const opts = { limit: 3, windowMs: WINDOW }
    for (let i = 0; i < 3; i++) await checkRateLimit(key, opts)
    expect((await checkRateLimit(key, opts)).allowed).toBe(false)
    await capRowsPerGroup(side, { cap: 0, hardCeiling: 1_000_000, onlyGroups: [""] })
    expect((await checkRateLimit(key, opts)).allowed).toBe(false)
  })
})
