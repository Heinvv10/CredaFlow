import { describe, expect, it, vi } from "vitest"
import { parsePeriodKey } from "./period"
import { carriedLoanIds, ifrs9RunRefusal, loadIfrs9Positions } from "./store-ifrs9"
import { DEFAULT_SETTINGS } from "@/lib/ifrs9/types"

const oct = parsePeriodKey("2026-10")!

const dbWith = (settings: Record<string, unknown> | null, run: { id: string } | null) => ({
  ifrs9Config: { findUnique: vi.fn(async () => settings) },
  ifrs9Run: { findFirst: vi.fn(async () => run) },
}) as never

const config = (over: Record<string, unknown>) => ({ ...DEFAULT_SETTINGS, ...over })

describe("ifrs9RunRefusal", () => {
  it("asks for nothing while IFRS 9 is off", async () => {
    expect(await ifrs9RunRefusal(dbWith(config({ enabled: false }), null), "t", oct)).toBeNull()
    expect(await ifrs9RunRefusal(dbWith(null, null), "t", oct)).toBeNull()
  })

  it("asks for nothing for a month before the one IFRS 9 takes effect", async () => {
    expect(await ifrs9RunRefusal(dbWith(config({ enabled: true, effectiveFromMonth: "2026-11" }), null), "t", oct)).toBeNull()
  })

  it("refuses an enabled month without its run, naming the route that adds it", async () => {
    const message = await ifrs9RunRefusal(dbWith(config({ enabled: true, effectiveFromMonth: "2026-10" }), null), "t", oct)
    expect(message).toContain("October 2026")
    expect(message).toContain("POST /api/ifrs9/runs/monthly")
  })

  it("is satisfied by the month's current run, and from the effective month on when none is named", async () => {
    expect(await ifrs9RunRefusal(dbWith(config({ enabled: true }), { id: "r1" }), "t", oct)).toBeNull()
    expect(await ifrs9RunRefusal(dbWith(config({ enabled: true, effectiveFromMonth: "2026-10" }), { id: "r1" }), "t", oct)).toBeNull()
  })

  it("looks only for a run no other run supersedes", async () => {
    const db = dbWith(config({ enabled: true }), null)
    await ifrs9RunRefusal(db, "t", oct)
    expect((db as unknown as { ifrs9Run: { findFirst: ReturnType<typeof vi.fn> } }).ifrs9Run.findFirst)
      .toHaveBeenCalledWith({ where: { tenantId: "t", kind: "MONTHLY", periodKey: "2026-10", supersededBy: null }, select: { id: true } })
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
      ifrs9Run: { findFirst: findRun },
      ifrs9LoanSnapshot: { findMany: vi.fn(async () => [snap("a", 500)]) },
      loan: { findMany: vi.fn(async () => [{ id: "a", reference: "L-A", contractType: "LOAN", status: "ACTIVE", writeOffAt: null, closedAt: null }]) },
    } as never
    const positions = await loadIfrs9Positions(db, "t", oct, new Set())
    expect(findRun).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ supersededBy: null, kind: "MONTHLY" }) }))
    expect(positions).toEqual([expect.objectContaining({ loanId: "a", periodKey: "2026-10", eclCents: 500, journalsSuspense: true, closed: false, writtenOff: false })])
  })

  it("marks a contract type whose suspense is not journalled, from the loan and not from a stored flag", async () => {
    const db = {
      ifrs9Run: { findFirst: vi.fn(async () => ({ id: "r2", periodKey: "2026-10" })) },
      ifrs9LoanSnapshot: { findMany: vi.fn(async () => [snap("af", 900)]) },
      loan: { findMany: vi.fn(async () => [{ id: "af", reference: "L-AF", contractType: "FINANCE_LEASE", status: "DEFAULTED", writeOffAt: null, closedAt: null }]) },
    } as never
    expect((await loadIfrs9Positions(db, "t", oct, new Set()))[0]).toMatchObject({ journalsSuspense: false })
  })

  it("carries a loan the run no longer lists: written off keeps its last allowance, settled is released", async () => {
    const db = {
      ifrs9Run: { findFirst: vi.fn(async () => ({ id: "r2", periodKey: "2026-10" })) },
      ifrs9LoanSnapshot: {
        findMany: vi.fn()
          .mockResolvedValueOnce([snap("keep", 100)])
          .mockResolvedValueOnce([{ ...snap("wo", 700), run: { periodKey: "2026-09" } }, { ...snap("done", 300), run: { periodKey: "2026-09" } }]),
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
    const db = { ifrs9Run: { findFirst: vi.fn(async () => null) }, ifrs9LoanSnapshot: { findMany: vi.fn(async () => []) }, loan: { findMany: vi.fn() } } as never
    expect(await loadIfrs9Positions(db, "t", oct, new Set())).toEqual([])
  })
})
