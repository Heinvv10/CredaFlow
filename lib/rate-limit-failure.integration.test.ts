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
  it("keeps the newest rows of a group above the cap and leaves other groups alone", async () => {
    const { capRowsPerGroup } = await import("./rate-limit-cleanup")
    const group = `flood-${randomUUID()}`
    const other = `calm-${randomUUID()}`
    const rows = (ns: string, n: number) => Array.from({ length: n }, (_, i) => ({ keyHash: `${ns}-${i}`, ns, hits: [new Date()], expiresAt: new Date(Date.now() + (i + 1) * 60_000) }))
    await side.rateLimitHit.createMany({ data: [...rows(group, 12), ...rows(other, 3)] })
    const removed = await capRowsPerGroup(side, 5, [group, other])
    expect(removed).toBe(7)
    expect(await side.rateLimitHit.count({ where: { ns: group } })).toBe(5)
    expect(await side.rateLimitHit.count({ where: { ns: other } })).toBe(3)
    // the survivors are the ones that expire last
    expect((await side.rateLimitHit.findMany({ where: { ns: group }, select: { keyHash: true } })).map((r) => r.keyHash).sort())
      .toEqual([7, 8, 9, 10, 11].map((i) => `${group}-${i}`).sort())
    await side.rateLimitHit.deleteMany({ where: { ns: { in: [group, other] } } })
  })
})
