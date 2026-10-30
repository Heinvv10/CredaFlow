import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const log = vi.hoisted(() => ({ error: vi.fn() }))
vi.mock("@/lib/observability/logger", () => ({ logger: { error: log.error, warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }))
vi.mock("@/lib/prisma", () => ({ prisma: {} }))
vi.mock("@/lib/tenant-scope", () => ({ withoutTenantScope: <T,>(fn: () => Promise<T>) => fn() }))

// A fake store: chain "bad" fails while its batch is larger than `maxOk`; the others link every row they have.
const world = vi.hoisted(() => ({
  chains: [] as string[], rows: new Map<string, number>(), maxOk: new Map<string, number>(), attempts: [] as Array<[string, number]>, linked: new Map<string, number>(),
  held: new Set<string>(),
  onAttempt: null as null | ((key: string) => void),
}))
vi.mock("./store", () => ({
  candidateChains: async () => world.chains,
  lockChain: async (_tx: unknown, key: string) => !world.held.has(key),
  chainHead: async () => null,
  unlinkedRows: async (_tx: unknown, key: string, _mode: string, _margin: number, limit: number) => {
    world.attempts.push([key, limit])
    world.onAttempt?.(key)
    if (limit > (world.maxOk.get(key) ?? Infinity)) throw new Error("canceling statement due to statement timeout")
    const left = (world.rows.get(key) ?? 0) - (world.linked.get(key) ?? 0)
    return Array.from({ length: Math.min(limit, left) }, (_, i) => ({
      auditLogId: `${key}-${(world.linked.get(key) ?? 0) + i}`, tenantId: key, userId: null, action: "X", entity: "E", entityId: null, createdAt: "2026-10-29T10:00:00.000",
      userEmailSha: null, ipAddressSha: null, oldValueSha: null, newValueSha: null, userEmailRed: null, ipAddressRed: null, oldValueRed: null, newValueRed: null,
    }))
  },
  appendLinks: async (_tx: unknown, key: string, links: unknown[]) => { world.linked.set(key, (world.linked.get(key) ?? 0) + links.length); return links.length },
}))
process.env.AUDIT_CHAIN_KEY = "k".repeat(40)

import { BUSY_ALERT_PASSES, BATCH, CHAIN_RETRY_BUDGET_MS, noteBusy, resetChainerState, runChainer } from "./chainer"
const db = { $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({}) } as never

beforeEach(() => {
  resetChainerState()
  world.chains = []; world.rows.clear(); world.maxOk.clear(); world.attempts = []; world.linked.clear(); world.held.clear(); world.onAttempt = null
  log.error.mockClear(); noteBusy("t-reset", false); noteBusy("t1", false); noteBusy("t2", false)
})

describe("the busy-chain alert", () => {
  it("says so once a chain has been held by another chainer for too many passes in a row", () => {
    for (let i = 1; i < BUSY_ALERT_PASSES; i++) noteBusy("t1", true)
    expect(log.error).not.toHaveBeenCalled()
    noteBusy("t1", true)
    expect(log.error).toHaveBeenCalledTimes(1)
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining("held by another chainer"), { chainKey: "t1", passes: BUSY_ALERT_PASSES })
    for (let i = 0; i < 50; i++) noteBusy("t1", true) // once, not on every pass
    expect(log.error).toHaveBeenCalledTimes(1)
  })

  it("starts counting again after a pass that was not held, and counts each chain apart", () => {
    for (let i = 1; i < BUSY_ALERT_PASSES; i++) { noteBusy("t1", true); noteBusy("t2", true) }
    noteBusy("t1", false)
    noteBusy("t1", true)
    noteBusy("t2", true)
    expect(log.error).toHaveBeenCalledTimes(1)
    expect(log.error).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ chainKey: "t2" }))
  })
})

describe("one chain cannot stop the others", () => {
  it("chains every other lender when one lender's chain keeps failing, and reports the failure", async () => {
    world.chains = ["bad", "good1", "good2"]
    world.rows.set("bad", 10); world.rows.set("good1", 3); world.rows.set("good2", 4)
    world.maxOk.set("bad", 0) // fails at every batch size, down to one row
    const result = await runChainer({ db, mode: "shallow" })
    expect(result).toMatchObject({ chains: 3, failed: 1, linked: 7, skipped: 0 })
    expect(world.linked.get("good1")).toBe(3)
    expect(world.linked.get("good2")).toBe(4)
    expect(world.linked.has("bad")).toBe(false)
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining("could not be chained"), expect.objectContaining({ chainKey: "bad" }))
  })

  it("halves the batch after a failure until it fits, links the heavy chain's rows at that size, and moves on", async () => {
    world.chains = ["heavy", "light"]
    world.rows.set("heavy", 100); world.rows.set("light", 5)
    world.maxOk.set("heavy", 30) // 500 -> 250 -> 125 -> 62 -> 31 -> 15 works
    const result = await runChainer({ db, mode: "shallow" })
    expect(result).toMatchObject({ failed: 0, linked: 105 })
    expect(world.attempts.filter(([k]) => k === "heavy").slice(0, 6).map(([, n]) => n)).toEqual([BATCH, 250, 125, 62, 31, 15])
    expect(world.linked.get("heavy")).toBe(100)
  })

  it("skips a chain another chainer holds, counts it busy, and still does the rest", async () => {
    world.chains = ["held", "free"]
    world.rows.set("held", 2); world.rows.set("free", 2)
    world.held.add("held")
    expect(await runChainer({ db, mode: "shallow" })).toMatchObject({ busy: 1, failed: 0, linked: 2 })
  })
})

describe("the retry budget", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-30T10:00:00Z")) })
  afterEach(() => { vi.useRealTimers() })
  const advance = (ms: number) => vi.setSystemTime(Date.now() + ms)

  it("stops retrying a stalled chain once its budget is spent, and still chains the other lenders in the same pass", async () => {
    world.chains = ["a-stalled", "b-good"]
    world.rows.set("a-stalled", 1000); world.rows.set("b-good", 5)
    world.maxOk.set("a-stalled", 0)
    world.onAttempt = (key) => { if (key === "a-stalled") advance(8_000) } // every attempt on it burns 8 s, then fails
    const result = await runChainer({ db, mode: "shallow", budgetMs: 10 * 60_000 })
    expect(result).toMatchObject({ failed: 1, linked: 5 })
    const tries = world.attempts.filter(([k]) => k === "a-stalled").map(([, n]) => n)
    expect(tries.length).toBeLessThanOrEqual(Math.ceil(CHAIN_RETRY_BUDGET_MS / 8_000) + 2) // not 500, 250 ... 1 (ten tries)
    expect(tries.length).toBeLessThan(10)
    expect(world.linked.get("b-good")).toBe(5)
  })

  it("leaves a chain that failed alone for a while (backing off, doubling), then tries it again", async () => {
    world.chains = ["bad", "good"]
    world.rows.set("bad", 10); world.rows.set("good", 2)
    world.maxOk.set("bad", 0)
    expect(await runChainer({ db, mode: "shallow" })).toMatchObject({ failed: 1, skipped: 0 })
    const triedFirst = world.attempts.filter(([k]) => k === "bad").length
    expect(await runChainer({ db, mode: "shallow" })).toMatchObject({ failed: 0, skipped: 1 })
    expect(world.attempts.filter(([k]) => k === "bad")).toHaveLength(triedFirst) // not touched during the backoff
    advance(31_000)
    expect(await runChainer({ db, mode: "shallow" })).toMatchObject({ failed: 1, skipped: 0 })
    expect(world.attempts.filter(([k]) => k === "bad").length).toBeGreaterThan(triedFirst)
    advance(31_000) // the second failure backs off for a minute, not 30 s
    expect(await runChainer({ db, mode: "shallow" })).toMatchObject({ skipped: 1 })
    advance(31_000)
    expect(await runChainer({ db, mode: "shallow" })).toMatchObject({ failed: 1 })
  })

  it("starts the next pass near the size that worked for a chain, not back at the top", async () => {
    world.chains = ["heavy"]
    world.rows.set("heavy", 100)
    world.maxOk.set("heavy", 30)
    await runChainer({ db, mode: "shallow" })
    expect(world.linked.get("heavy")).toBe(100)
    world.rows.set("heavy", 200)
    world.attempts = []
    await runChainer({ db, mode: "shallow" })
    expect(world.attempts[0]).toEqual(["heavy", 30]) // 15 worked last time; double it
    expect(world.attempts.map(([, n]) => n)).not.toContain(BATCH)
  })

  it("never retries past the pass deadline", async () => {
    world.chains = ["slow"]
    world.rows.set("slow", 1000)
    world.maxOk.set("slow", 0)
    world.onAttempt = () => advance(5_000)
    await runChainer({ db, mode: "shallow", budgetMs: 4_000, retryBudgetMs: 10 * 60_000 })
    expect(world.attempts).toHaveLength(1) // the first failure is already past the deadline
  })
})
