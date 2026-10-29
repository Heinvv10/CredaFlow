import { beforeEach, describe, expect, it, vi } from "vitest"

const rows = new Map<string, { value: string; expiresAt: Date }>()

vi.mock("@/lib/prisma", () => ({
  prisma: {
    ssoCacheEntry: {
      create: vi.fn(async ({ data }: { data: { key: string; value: string; expiresAt: Date } }) => {
        if (rows.has(data.key)) throw Object.assign(new Error("unique"), { code: "P2002" })
        rows.set(data.key, { value: data.value, expiresAt: data.expiresAt })
      }),
      findUnique: vi.fn(async ({ where }: { where: { key: string } }) => {
        const row = rows.get(where.key)
        return row ? { key: where.key, ...row } : null
      }),
      deleteMany: vi.fn(async ({ where }: { where: { key?: string; expiresAt?: { lt: Date } } }) => {
        let count = 0
        for (const [key, row] of [...rows]) {
          if ((where.key === undefined || key === where.key) && (!where.expiresAt || row.expiresAt < where.expiresAt.lt)) {
            rows.delete(key)
            count++
          }
        }
        return { count }
      }),
    },
  },
}))

import { DbSamlCache, claimOnce } from "./cache"

beforeEach(() => rows.clear())

describe("claimOnce", () => {
  it("lets the first claim win and refuses a repeat", async () => {
    const until = new Date(Date.now() + 60_000)
    expect(await claimOnce("ticket:a", until)).toBe(true)
    expect(await claimOnce("ticket:a", until)).toBe(false)
  })

  it("lets an expired claim be taken again", async () => {
    expect(await claimOnce("ticket:b", new Date(Date.now() - 1))).toBe(true)
    expect(await claimOnce("ticket:b", new Date(Date.now() + 60_000))).toBe(true)
  })

  it("keeps different keys apart", async () => {
    const until = new Date(Date.now() + 60_000)
    expect(await claimOnce("ticket:c", until)).toBe(true)
    expect(await claimOnce("ticket:d", until)).toBe(true)
  })
})

describe("DbSamlCache", () => {
  it("consumes a saved request id exactly once", async () => {
    const cache = new DbSamlCache("t1", 60_000)
    await cache.saveAsync("_req1", "2026-10-29T00:00:00Z")
    expect(await cache.consumeAsync("_req1")).toBe("2026-10-29T00:00:00Z")
    expect(await cache.consumeAsync("_req1")).toBeNull()
  })

  it("does not return a request id past its life", async () => {
    const cache = new DbSamlCache("t1", -1)
    await cache.saveAsync("_req2", "x")
    expect(await cache.getAsync("_req2")).toBeNull()
    expect(await cache.consumeAsync("_req2")).toBeNull()
  })

  it("keeps lenders apart", async () => {
    await new DbSamlCache("t1", 60_000).saveAsync("_req3", "x")
    expect(await new DbSamlCache("t2", 60_000).consumeAsync("_req3")).toBeNull()
  })

  it("saveIfAbsentAsync refuses an assertion id seen before", async () => {
    const cache = new DbSamlCache("t1", 60_000)
    const until = Date.now() + 60_000
    expect(await cache.saveIfAbsentAsync("_assert1", "1", until)).toBe(true)
    expect(await cache.saveIfAbsentAsync("_assert1", "1", until)).toBe(false)
  })
})
