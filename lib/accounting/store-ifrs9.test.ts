import { describe, expect, it, vi } from "vitest"
import { parsePeriodKey } from "./period"
import { carriedLoanIds, ifrs9RunRefusal, loadIfrs9Positions } from "./store-ifrs9"
import { DEFAULT_SETTINGS } from "@/lib/ifrs9/types"

const oct = parsePeriodKey("2026-10")!

const dbWith = (settings: Record<string, unknown> | null, run: { id: string; createdAt?: Date } | null, newer: { periodKey: string } | null = null) => ({
  ifrs9Config: { findUnique: vi.fn(async () => settings) },
  ifrs9Run: { findFirst: vi.fn().mockResolvedValueOnce(run ? { createdAt: new Date("2026-11-01T00:00:00Z"), ...run } : null).mockResolvedValue(newer) },
}) as never

const config = (over: Record<string, unknown>) => ({ ...DEFAULT_SETTINGS, ...over })
const cfg = { findUnique: vi.fn(async () => config({ enabled: true })) }

describe("ifrs9RunRefusal", () => {
  it("asks for nothing while IFRS 9 is off", async () => {
    expect(await ifrs9RunRefusal(dbWith(config({ enabled: false }), null), "t", oct)).toBeNull()
    expect(await ifrs9RunRefusal(dbWith(null, null), "t", oct)).toBeNull()
  })

  it("asks for nothing for a month before the one IFRS 9 takes effect", async () => {
    expect(await ifrs9RunRefusal(dbWith(config({ enabled: true, effectiveFromMonth: "2026-11" }), null), "t", oct)).toBeNull()
  })

  it("refuses an enabled month without its run, naming the route that adds it", async () => {
    const refusal = await ifrs9RunRefusal(dbWith(config({ enabled: true, effectiveFromMonth: "2026-10" }), null), "t", oct)
    expect(refusal?.code).toBe("IFRS9_RUN_MISSING")
    expect(refusal?.message).toContain("October 2026")
    expect(refusal?.message).toContain("POST /api/ifrs9/runs/monthly")
  })

  it("is satisfied by the month's current run, and from the effective month on when none is named", async () => {
    expect(await ifrs9RunRefusal(dbWith(config({ enabled: true }), { id: "r1" }), "t", oct)).toBeNull()
    expect(await ifrs9RunRefusal(dbWith(config({ enabled: true, effectiveFromMonth: "2026-10" }), { id: "r1" }), "t", oct)).toBeNull()
  })

  it("looks only for a run no other run supersedes", async () => {
    const db = dbWith(config({ enabled: true }), null)
    await ifrs9RunRefusal(db, "t", oct)
    expect((db as unknown as { ifrs9Run: { findFirst: ReturnType<typeof vi.fn> } }).ifrs9Run.findFirst)
      .toHaveBeenCalledWith(expect.objectContaining({ where: { tenantId: "t", kind: "MONTHLY", periodKey: "2026-10", supersededBy: null } }))
  })

  it("refuses a month whose run was made before an earlier month's run was made or replaced (stale), naming the run to replace", async () => {
    const refusal = await ifrs9RunRefusal(dbWith(config({ enabled: true }), { id: "r-nov" }, { periodKey: "2026-09" }), "t", parsePeriodKey("2026-10")!)
    expect(refusal?.code).toBe("IFRS9_RUN_STALE")
    expect(refusal?.message).toContain("2026-09")
    expect(refusal?.message).toContain('supersedesRunId: "r-nov"')
  })

  it("asks for newer earlier runs only: a run made before the run it is compared with is not stale", async () => {
    const db = dbWith(config({ enabled: true }), { id: "r" }, null)
    expect(await ifrs9RunRefusal(db, "t", oct)).toBeNull()
    expect((db as unknown as { ifrs9Run: { findFirst: ReturnType<typeof vi.fn> } }).ifrs9Run.findFirst)
      .toHaveBeenLastCalledWith(expect.objectContaining({ where: { tenantId: "t", kind: "MONTHLY", supersededBy: null, periodKey: { lt: "2026-10" }, createdAt: { gt: new Date("2026-11-01T00:00:00Z") } } }))
  })
})

describe("carriedLoanIds", () => {
  it("reads the loan ids out of the IFRS 9 base keys and ignores every other source", () => {
    expect(carriedLoanIds(new Set(["ifrs9:ecl:a", "ifrs9:suspense:a", "ifrs9:ecl:b", "loan:c:disbursement"]))).toEqual(new Set(["a", "b"]))
  })
})

describe("loadIfrs9Positions", () => {
  const snap = (loanId: string, eclCents: number) => ({ loanId, eclCents, suspendedInterestCents: 0, suspendedDefaultInterestCents: 0 })

  it("reads the current monthly run only: a run that something supersedes is never read", async () => {
    const findRun = vi.fn(async () => ({ id: "r2", periodKey: "2026-10" }))
    const db = {
      ifrs9Config: cfg, ifrs9Run: { findFirst: findRun },
      ifrs9LoanSnapshot: { findMany: vi.fn(async () => [snap("a", 500)]), groupBy: vi.fn(async () => []) },
      loan: { findMany: vi.fn(async () => [{ id: "a", reference: "L-A", contractType: "LOAN", status: "ACTIVE", writeOffAt: null, closedAt: null }]) },
    } as never
    const positions = await loadIfrs9Positions(db, "t", oct, new Set())
    expect(findRun).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ supersededBy: null, kind: "MONTHLY" }) }))
    expect(positions).toEqual([expect.objectContaining({ loanId: "a", periodKey: "2026-10", eclCents: 500, journalsSuspense: true, closed: false, writtenOff: false })])
  })

  it("marks a contract type whose suspense is not journalled, from the loan and not from a stored flag", async () => {
    const db = {
      ifrs9Config: cfg, ifrs9Run: { findFirst: vi.fn(async () => ({ id: "r2", periodKey: "2026-10" })) },
      ifrs9LoanSnapshot: { findMany: vi.fn(async () => [snap("af", 900)]), groupBy: vi.fn(async () => []) },
      loan: { findMany: vi.fn(async () => [{ id: "af", reference: "L-AF", contractType: "FINANCE_LEASE", status: "DEFAULTED", writeOffAt: null, closedAt: null }]) },
    } as never
    expect((await loadIfrs9Positions(db, "t", oct, new Set()))[0]).toMatchObject({ journalsSuspense: false })
  })

  it("carries a loan the run no longer lists: written off keeps its last allowance, settled is released", async () => {
    const db = {
      ifrs9Config: cfg, ifrs9Run: { findFirst: vi.fn(async () => ({ id: "r2", periodKey: "2026-10" })) },
      ifrs9LoanSnapshot: {
        findMany: vi.fn()
          .mockResolvedValueOnce([snap("keep", 100)])
          .mockResolvedValueOnce([{ ...snap("wo", 700), run: { periodKey: "2026-09" } }, { ...snap("done", 300), run: { periodKey: "2026-09" } }]),
        groupBy: vi.fn(async () => []),
      },
      loan: {
        findMany: vi.fn(async () => [
          { id: "done", reference: "D", contractType: "LOAN", status: "COMPLETED", writeOffAt: null, closedAt: new Date("2026-10-10T00:00:00Z") },
          { id: "keep", reference: "K", contractType: "LOAN", status: "ACTIVE", writeOffAt: null, closedAt: null },
          { id: "wo", reference: "W", contractType: "LOAN", status: "WRITTEN_OFF", writeOffAt: new Date("2026-10-15T00:00:00Z"), closedAt: new Date("2026-10-15T00:00:00Z") },
        ]),
      },
    } as never
    const byId = Object.fromEntries((await loadIfrs9Positions(db, "t", oct, new Set(["ifrs9:ecl:wo", "ifrs9:ecl:done", "ifrs9:ecl:keep"]))).map((p) => [p.loanId, p]))
    expect(byId.wo).toMatchObject({ writtenOff: true, closed: false, eclCents: 700 })
    expect(byId.done).toMatchObject({ writtenOff: false, closed: true })
    expect(byId.keep).toMatchObject({ writtenOff: false, closed: false, eclCents: 100 })
  })

  it("is empty when there is no run", async () => {
    const db = { ifrs9Config: cfg, ifrs9Run: { findFirst: vi.fn(async () => null) }, ifrs9LoanSnapshot: { findMany: vi.fn(async () => []), groupBy: vi.fn(async () => []) }, loan: { findMany: vi.fn() } } as never
    expect(await loadIfrs9Positions(db, "t", oct, new Set())).toEqual([])
  })
})

describe("loadIfrs9Positions: who has left the book", () => {
  const snap = (loanId: string, eclCents: number) => ({ loanId, eclCents, suspendedInterestCents: 0, suspendedDefaultInterestCents: 0 })
  const loanRow = (over: Record<string, unknown>) => ({ id: "x", reference: "X", contractType: "LOAN", status: "ACTIVE", writeOffAt: null, closedAt: null, ...over })
  const dbFor = (listed: unknown[], carried: unknown[], loans: unknown[], net: unknown[] = []) => ({
    ifrs9Config: cfg, ifrs9Run: { findFirst: vi.fn(async () => ({ id: "r2", periodKey: "2026-10" })) },
    ifrs9LoanSnapshot: { findMany: vi.fn().mockResolvedValueOnce(listed).mockResolvedValueOnce(carried), groupBy: vi.fn(async () => net) },
    loan: { findMany: vi.fn(async () => loans) },
  }) as never

  // Review breakers 3a and 3c (PR #255 round 2): a loan exited AFTER the month end was on that month's book.
  it("keeps a loan the run does not list while it has not exited before the period ended (written off or settled only after)", async () => {
    const db = dbFor([], [{ ...snap("late", 400), run: { periodKey: "2026-09" } }], [
      loanRow({ id: "late", status: "WRITTEN_OFF", writeOffAt: new Date("2026-11-02T08:00:00Z"), closedAt: new Date("2026-11-02T08:00:00Z") }),
      loanRow({ id: "kept", status: "COMPLETED", closedAt: new Date("2026-11-03T08:00:00Z") }),
    ])
    const byId = Object.fromEntries((await loadIfrs9Positions(db, "t", oct, new Set(["ifrs9:ecl:late", "ifrs9:ecl:kept"]))).map((p) => [p.loanId, p]))
    expect(byId.late).toMatchObject({ writtenOff: false, closed: false, eclCents: 400 })
    expect(byId.kept).toMatchObject({ writtenOff: false, closed: false })
  })

  it("sums the net-basis adjustments over the runs up to the period, including for a loan the run no longer lists", async () => {
    const db = dbFor([snap("a", 500)], [], [loanRow({ id: "a" }), loanRow({ id: "gone", status: "COMPLETED", closedAt: new Date("2026-10-05T08:00:00Z") })],
      [{ loanId: "a", _sum: { netInterestAdjustmentCents: 6_000, netDefaultInterestAdjustmentCents: 2_400 } }, { loanId: "gone", _sum: { netInterestAdjustmentCents: 1_500, netDefaultInterestAdjustmentCents: null } }])
    const byId = Object.fromEntries((await loadIfrs9Positions(db, "t", oct, new Set())).map((p) => [p.loanId, p]))
    expect(byId.a).toMatchObject({ netInterestAdjustmentCents: 6_000, netDefaultInterestAdjustmentCents: 2_400 })
    expect(byId.gone).toMatchObject({ closed: true, netInterestAdjustmentCents: 1_500, netDefaultInterestAdjustmentCents: 0 })
  })

  it("posts nothing for a month IFRS 9 does not govern: off, or before its first month, whatever runs are on record", async () => {
    for (const over of [{ enabled: false }, { enabled: true, effectiveFromMonth: "2026-11" }]) {
      const findRun = vi.fn(async () => ({ id: "r2", periodKey: "2026-10" }))
      const db = { ifrs9Config: { findUnique: vi.fn(async () => config(over)) }, ifrs9Run: { findFirst: findRun }, ifrs9LoanSnapshot: { findMany: vi.fn(), groupBy: vi.fn() }, loan: { findMany: vi.fn() } } as never
      expect(await loadIfrs9Positions(db, "t", oct, new Set(["ifrs9:ecl:a"]))).toEqual([])
      expect(findRun).not.toHaveBeenCalled()
    }
  })

  it("sums net-basis adjustments only from the first governed month, and only rows that adjusted something", async () => {
    const groupBy = vi.fn(async () => [])
    const db = {
      ifrs9Config: { findUnique: vi.fn(async () => config({ enabled: true, effectiveFromMonth: "2026-09" })) },
      ifrs9Run: { findFirst: vi.fn(async () => ({ id: "r2", periodKey: "2026-10" })) },
      ifrs9LoanSnapshot: { findMany: vi.fn(async () => []), groupBy }, loan: { findMany: vi.fn(async () => []) },
    } as never
    await loadIfrs9Positions(db, "t", oct, new Set())
    expect(groupBy).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ run: expect.objectContaining({ periodKey: { gte: "2026-09", lte: "2026-10" }, supersededBy: null }), OR: [{ netInterestAdjustmentCents: { gt: 0 } }, { netDefaultInterestAdjustmentCents: { gt: 0 } }] }),
    }))
  })

  it("flags a loan whose status says it left the book without the date it did so", async () => {
    const db = dbFor([snap("a", 500)], [{ ...snap("w", 300), run: { periodKey: "2026-09" } }, { ...snap("c", 200), run: { periodKey: "2026-09" } }], [
      loanRow({ id: "a" }), loanRow({ id: "w", status: "WRITTEN_OFF" }), loanRow({ id: "c", status: "COMPLETED" }),
    ])
    const byId = Object.fromEntries((await loadIfrs9Positions(db, "t", oct, new Set(["ifrs9:ecl:w", "ifrs9:ecl:c"]))).map((p) => [p.loanId, p]))
    expect(byId.a.exitUndated).toBe(false)
    expect(byId.w.exitUndated).toBe(true)
    expect(byId.c.exitUndated).toBe(true)
  })
})

describe("ifrs9RunRefusal: the Stage 3 interest basis", () => {
  it("refuses a run made on the other basis than the lender's now, naming the run to replace", async () => {
    const db = {
      ifrs9Config: { findUnique: vi.fn(async () => config({ enabled: true, stage3InterestBasis: "NET_BASIS" })) },
      ifrs9Run: { findFirst: vi.fn().mockResolvedValueOnce({ id: "r1", createdAt: new Date("2026-11-01T00:00:00Z"), settings: { stage3InterestBasis: "FULL_SUSPENSION" } }).mockResolvedValue(null) },
    } as never
    const refusal = await ifrs9RunRefusal(db, "t", oct)
    expect(refusal?.code).toBe("IFRS9_RUN_STALE")
    expect(refusal?.message).toContain("FULL_SUSPENSION")
    expect(refusal?.message).toContain('supersedesRunId: "r1"')
  })
})
