import { Prisma } from "@prisma/client"
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/lib/prisma", () => ({ prisma: {} }))
const { logAudit } = vi.hoisted(() => ({ logAudit: vi.fn() }))
vi.mock("@/lib/audit", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/audit")>()), logAudit }))

import { feedSkipReason, runReferenceRateFeed, syncReferenceRatesFromFeed, ZARONIA_MIN_MOVE } from "./rate-feed-sync"
import type { SarbObservation } from "./sarb-rate-feed"

// The decision rules and the write path against an in-memory stand-in. What
// the database itself enforces (born PENDING, the unique live value, the
// source/requester CHECK) is proven in rate-feed.integration.test.ts.

type Basis = "PRIME" | "REPO" | "ZARONIA"
interface Row { id: string; tenantId: string; basis: Basis; effectiveDate: Date; rate: Prisma.Decimal; status: string; source: string; createdAt: Date }

const D = (value: string) => new Prisma.Decimal(value)
const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`)
const obs = (basis: Basis, rate: string, effectiveDate = "2026-10-16"): SarbObservation => ({ basis, timeseriesCode: "X", effectiveDate, rate: D(rate) })
const feed = [obs("REPO", "0.0725"), obs("PRIME", "0.1075"), obs("ZARONIA", "0.07097", "2026-10-15")]

function fakeDb(rows: Row[], opts: { flagged?: string[]; uniqueClash?: boolean; failTenant?: string } = {}) {
  const flagged = opts.flagged ?? ["t1"]
  const created: Row[] = []
  const audits: Array<Record<string, unknown>> = []
  const bell: Array<Record<string, unknown>> = []
  let seq = 0
  const match = (row: Row, where: Record<string, unknown>) =>
    Object.entries(where).every(([key, want]) => {
      const have = (row as unknown as Record<string, unknown>)[key]
      if (want && typeof want === "object" && "in" in want) return (want.in as unknown[]).includes(have)
      if (want instanceof Prisma.Decimal) return (have as Prisma.Decimal).equals(want)
      return have === want
    })
  const referenceRate = {
    findFirst: vi.fn(async ({ where, orderBy }: { where: Record<string, unknown>; orderBy?: Array<Record<string, "desc">> }) => {
      const hits = [...rows, ...created].filter((r) => match(r, where))
      if (orderBy) hits.sort((a, b) => b.effectiveDate.getTime() - a.effectiveDate.getTime() || b.createdAt.getTime() - a.createdAt.getTime())
      return hits[0] ?? null
    }),
    create: vi.fn(async ({ data }: { data: Omit<Row, "id" | "status" | "createdAt"> }) => {
      if (opts.failTenant === data.tenantId) throw new Error("connection reset")
      if (opts.uniqueClash) throw new Prisma.PrismaClientKnownRequestError("unique", { code: "P2002", clientVersion: "test" })
      const row: Row = { ...data, id: `rr${++seq}`, status: "PENDING", createdAt: new Date() }
      created.push(row)
      return row
    }),
  }
  const tx = {
    referenceRate,
    auditLog: { create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => { audits.push(data) }) },
    user: { findMany: vi.fn(async () => [{ id: "admin-1" }, { id: "admin-2" }]) },
    notification: { createMany: vi.fn(async ({ data }: { data: Array<Record<string, unknown>> }) => { bell.push(...data) }) },
  }
  const db = {
    ...tx,
    tenantConfig: { findMany: vi.fn(async () => flagged.map((tenantId) => ({ tenantId }))) },
    // A real transaction rolls back its writes on error; the stand-in does the same for `created`.
    $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => {
      const before = [created.length, audits.length, bell.length]
      try {
        return await fn(tx)
      } catch (error) {
        created.length = before[0]; audits.length = before[1]; bell.length = before[2]
        throw error
      }
    }),
  }
  return { db: db as never, created, audits, bell, referenceRate, tenantConfig: db.tenantConfig }
}

const existing = (basis: Basis, rate: string, over: Partial<Row> = {}): Row => ({
  id: `ex-${basis}-${rate}`, tenantId: "t1", basis, effectiveDate: day("2026-09-01"), rate: D(rate), status: "APPROVED", source: "MANUAL", createdAt: day("2026-09-01"), ...over,
})

describe("feedSkipReason", () => {
  const latest = (rate: string, date = "2026-09-01") => ({ rate: D(rate), effectiveDate: day(date) })

  it("records a basis with no value yet", () => {
    expect(feedSkipReason(null, obs("PRIME", "0.1075"))).toBeNull()
    expect(feedSkipReason(null, obs("ZARONIA", "0.07097"))).toBeNull()
  })

  it("skips the same value, whatever the basis", () => {
    for (const basis of ["PRIME", "REPO", "ZARONIA"] as const) expect(feedSkipReason(latest("0.1075"), obs(basis, "0.1075"))).toBe("unchanged")
  })

  it("records any other PRIME or REPO value, however small the move", () => {
    expect(feedSkipReason(latest("0.1075"), obs("PRIME", "0.107501"))).toBeNull()
    expect(feedSkipReason(latest("0.0725"), obs("REPO", "0.0700"))).toBeNull()
  })

  it("records ZARONIA from exactly 25 bp away, in either direction, and not from 24.9 bp", () => {
    expect(ZARONIA_MIN_MOVE.toString()).toBe("0.0025")
    expect(feedSkipReason(latest("0.07"), obs("ZARONIA", "0.0725"))).toBeNull()
    expect(feedSkipReason(latest("0.0725"), obs("ZARONIA", "0.07"))).toBeNull()
    expect(feedSkipReason(latest("0.07"), obs("ZARONIA", "0.072499"))).toBe("below_threshold")
    expect(feedSkipReason(latest("0.0725"), obs("ZARONIA", "0.070001"))).toBe("below_threshold")
    expect(feedSkipReason(latest("0.07"), obs("ZARONIA", "0.07097"))).toBe("below_threshold")
  })

  it("does not apply the 25 bp threshold to PRIME or REPO", () => {
    expect(feedSkipReason(latest("0.07"), obs("PRIME", "0.0725"))).toBeNull()
  })

  it("skips an observation dated before the latest live value", () => {
    expect(feedSkipReason(latest("0.1075", "2026-10-20"), obs("PRIME", "0.11", "2026-10-16"))).toBe("stale")
    expect(feedSkipReason(latest("0.1075", "2026-10-16"), obs("PRIME", "0.11", "2026-10-16"))).toBeNull()
  })
})

describe("syncReferenceRatesFromFeed", () => {
  beforeEach(() => { logAudit.mockReset() })

  it("records each basis with no value yet: PENDING-bound, SARB_FEED, no requester, audited, bell to the admins", async () => {
    const { db, created, audits, bell, referenceRate } = fakeDb([])
    const [run] = await syncReferenceRatesFromFeed(db, feed)
    expect(run.recorded.map((r) => [r.basis, r.effectiveDate, r.rate])).toEqual([
      ["REPO", "2026-10-16", "0.0725"], ["PRIME", "2026-10-16", "0.1075"], ["ZARONIA", "2026-10-15", "0.07097"],
    ])
    expect(created).toHaveLength(3)
    for (const [{ data }] of referenceRate.create.mock.calls) {
      expect(data).toMatchObject({ tenantId: "t1", source: "SARB_FEED" })
      // No requester, and no status: the row takes the PENDING default and the database refuses anything else.
      expect(Object.keys(data).sort()).toEqual(["basis", "effectiveDate", "rate", "source", "tenantId"])
    }
    expect(audits.map((a) => [a.tenantId, a.userId, a.userEmail, a.action, a.entityId])).toEqual(
      created.map((r) => ["t1", null, "system@sarb-rate-feed", "REFERENCE_RATE_RECORDED", r.id]),
    )
    expect(audits[0].newValue).toMatchObject({ basis: "REPO", source: "SARB_FEED", rate: "0.0725", status: "PENDING" })
    expect(bell.filter((b) => b.entityId === created[1].id).map((b) => [b.userId, b.type, b.title])).toEqual([
      ["admin-1", "REFERENCE_RATE_FEED_PENDING", "SARB feed: PRIME 10.75% observed 2026-10-16 awaits approval"],
      ["admin-2", "REFERENCE_RATE_FEED_PENDING", "SARB feed: PRIME 10.75% observed 2026-10-16 awaits approval"],
    ])
    expect(bell.find((b) => b.entityId === created[2].id)?.title).toBe("SARB feed: ZARONIA 7.097% observed 2026-10-15 awaits approval")
  })

  it("formats a whole percent with two places", async () => {
    const { db, bell } = fakeDb([])
    await syncReferenceRatesFromFeed(db, [obs("PRIME", "0.11", "2026-11-21")])
    expect(bell[0].title).toBe("SARB feed: PRIME 11.00% observed 2026-11-21 awaits approval")
  })

  it("records nothing when every value matches the latest live one (approved or pending)", async () => {
    const { db, created } = fakeDb([existing("REPO", "0.0725"), existing("PRIME", "0.1075", { status: "PENDING" }), existing("ZARONIA", "0.07097")])
    const [run] = await syncReferenceRatesFromFeed(db, feed)
    expect(created).toHaveLength(0)
    expect(run.skipped).toEqual({ unchanged: 3 })
  })

  it("records a changed PRIME and REPO, and a ZARONIA 25 bp away, but not a ZARONIA 24 bp away", async () => {
    const moved = fakeDb([existing("REPO", "0.07"), existing("PRIME", "0.11"), existing("ZARONIA", "0.0684")])
    expect((await syncReferenceRatesFromFeed(moved.db, feed))[0].recorded.map((r) => r.basis)).toEqual(["REPO", "PRIME", "ZARONIA"])
    const near = fakeDb([existing("REPO", "0.0725"), existing("PRIME", "0.1075"), existing("ZARONIA", "0.0686")])
    const [run] = await syncReferenceRatesFromFeed(near.db, feed)
    expect(run.recorded).toEqual([])
    expect(run.skipped).toEqual({ unchanged: 2, below_threshold: 1 })
  })

  it("compares with the LATEST live value, not an older one", async () => {
    const { db, created } = fakeDb([
      existing("PRIME", "0.1075", { effectiveDate: day("2026-01-01") }),
      existing("PRIME", "0.11", { effectiveDate: day("2026-09-01"), status: "PENDING" }),
    ])
    await syncReferenceRatesFromFeed(db, [obs("PRIME", "0.1075")])
    expect(created).toHaveLength(1) // 0.1075 differs from the latest, 0.11
  })

  it("ignores a REJECTED value when finding the latest", async () => {
    const { db, created } = fakeDb([existing("PRIME", "0.1075", { effectiveDate: day("2026-01-01") }), existing("PRIME", "0.12", { status: "REJECTED" })])
    await syncReferenceRatesFromFeed(db, [obs("PRIME", "0.1075")])
    expect(created).toHaveLength(0)
  })

  it("does not record a second PENDING feed row with the same value", async () => {
    // The latest live value (0.12, a later date) differs from the feed, but a feed row for 0.1075 already waits.
    const { db, created } = fakeDb([
      existing("PRIME", "0.1075", { status: "PENDING", source: "SARB_FEED", effectiveDate: day("2026-10-01") }),
      existing("PRIME", "0.12", { status: "PENDING", source: "MANUAL", effectiveDate: day("2026-10-10") }),
    ])
    const [run] = await syncReferenceRatesFromFeed(db, [obs("PRIME", "0.1075", "2026-10-16")])
    expect(created).toHaveLength(0)
    expect(run.skipped).toEqual({ already_pending: 1 })
  })

  it("does not re-ask a value whose latest feed row was REJECTED", async () => {
    const rejected = existing("PRIME", "0.1100", { id: "rej", source: "SARB_FEED", status: "REJECTED", effectiveDate: day("2026-10-10"), createdAt: day("2026-10-10") })
    const { db, created } = fakeDb([existing("PRIME", "0.1075"), rejected])
    const [run] = await syncReferenceRatesFromFeed(db, [obs("PRIME", "0.1100")])
    expect(created).toHaveLength(0)
    expect(run.skipped).toEqual({ rejected: 1 })
  })

  it("asks again when the feed moved after the rejection and came back", async () => {
    const rejected = existing("PRIME", "0.1100", { id: "rej", source: "SARB_FEED", status: "REJECTED", effectiveDate: day("2026-10-10"), createdAt: day("2026-10-10") })
    const later = existing("PRIME", "0.1125", { id: "later", source: "SARB_FEED", status: "REJECTED", effectiveDate: day("2026-10-13"), createdAt: day("2026-10-13") })
    const { db, created } = fakeDb([existing("PRIME", "0.1075"), rejected, later])
    await syncReferenceRatesFromFeed(db, [obs("PRIME", "0.1100")])
    expect(created.map((r) => r.rate.toString())).toEqual(["0.11"])
  })

  it("a PENDING MANUAL row with the same value does not count as a waiting feed row", async () => {
    const { db, created } = fakeDb([
      existing("PRIME", "0.1075", { status: "PENDING", source: "MANUAL", effectiveDate: day("2026-10-01") }),
      existing("PRIME", "0.12", { effectiveDate: day("2026-10-10") }),
    ])
    await syncReferenceRatesFromFeed(db, [obs("PRIME", "0.1075", "2026-10-16")])
    expect(created).toHaveLength(1)
  })

  it("skips a stale observation instead of recording it behind a later pre-recorded value", async () => {
    const { db, created } = fakeDb([existing("PRIME", "0.11", { effectiveDate: day("2026-11-21") })])
    const [run] = await syncReferenceRatesFromFeed(db, [obs("PRIME", "0.1075", "2026-10-16")])
    expect(created).toHaveLength(0)
    expect(run.skipped).toEqual({ stale: 1 })
  })

  it("counts a P2002 on the live key as already recorded: no row, no audit, no bell, no failure", async () => {
    const { db, audits, bell } = fakeDb([], { uniqueClash: true })
    const [run] = await syncReferenceRatesFromFeed(db, feed)
    expect(run).toMatchObject({ recorded: [], skipped: { already_recorded: 3 }, failed: 0 })
    expect(audits).toHaveLength(0)
    expect(bell).toHaveLength(0)
  })

  it("only syncs tenants that have asset finance on, and asks for exactly those", async () => {
    const { db, created, tenantConfig } = fakeDb([], { flagged: ["t1", "t2"] })
    const runs = await syncReferenceRatesFromFeed(db, [obs("PRIME", "0.1075")])
    expect(tenantConfig.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { featureAssetFinance: true } }))
    expect(runs.map((r) => r.tenantId)).toEqual(["t1", "t2"])
    expect(created.map((r) => r.tenantId)).toEqual(["t1", "t2"])
  })

  it("syncs no one when no tenant has asset finance on", async () => {
    const { db, created, referenceRate } = fakeDb([], { flagged: [] })
    expect(await syncReferenceRatesFromFeed(db, feed)).toEqual([])
    expect(created).toHaveLength(0)
    expect(referenceRate.findFirst).not.toHaveBeenCalled()
  })

  it("passes tenantId explicitly on every query (a cron has no tenant frame)", async () => {
    const { db, referenceRate } = fakeDb([existing("PRIME", "0.11")])
    await syncReferenceRatesFromFeed(db, feed)
    for (const [args] of referenceRate.findFirst.mock.calls) expect(args.where).toMatchObject({ tenantId: "t1" })
    for (const [args] of referenceRate.create.mock.calls) expect(args.data).toMatchObject({ tenantId: "t1" })
  })

  it("one tenant's failure is counted and the next tenant still syncs", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined)
    const { db, created } = fakeDb([], { flagged: ["bad", "t2"], failTenant: "bad" })
    const runs = await syncReferenceRatesFromFeed(db, [obs("PRIME", "0.1075")])
    expect(runs.map((r) => [r.tenantId, r.failed, r.recorded.length])).toEqual([["bad", 1, 0], ["t2", 0, 1]])
    expect(created.map((r) => r.tenantId)).toEqual(["t2"])
  })
})

describe("runReferenceRateFeed", () => {
  beforeEach(() => { logAudit.mockReset() })

  it("a feed that cannot be read records nothing, and is audited and reported", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined)
    const { db, created, tenantConfig } = fakeDb([])
    const run = await runReferenceRateFeed(db, async () => ({ ok: false, reason: "timeout", detail: "no answer within 15 s" }))
    expect(run).toEqual({ ok: false, reason: "feed_unavailable", feed: { ok: false, reason: "timeout", detail: "no answer within 15 s" } })
    expect(created).toHaveLength(0)
    expect(tenantConfig.findMany).not.toHaveBeenCalled()
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: "REFERENCE_RATE_FEED_FAILED", entity: "ReferenceRateFeed", newValue: { reason: "timeout", detail: "no answer within 15 s" },
    }))
  })

  it("reports ok with the per-tenant runs", async () => {
    const { db } = fakeDb([])
    const run = await runReferenceRateFeed(db, async () => ({ ok: true, observations: [obs("PRIME", "0.1075")] }))
    expect(run).toMatchObject({ ok: true, perTenant: [{ tenantId: "t1", recorded: [{ basis: "PRIME" }] }] })
    expect(logAudit).not.toHaveBeenCalled()
  })

  it("is not ok when a tenant failed", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined)
    const { db } = fakeDb([], { failTenant: "t1" })
    const run = await runReferenceRateFeed(db, async () => ({ ok: true, observations: [obs("PRIME", "0.1075")] }))
    expect(run).toMatchObject({ ok: false, reason: "tenant_failed" })
  })
})
