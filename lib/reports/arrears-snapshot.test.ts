import { describe, expect, it, vi } from "vitest"
import { bookArrearsFromSnapshot, snapshotDay, snapshotTenantArrears, type SnapshotRow } from "./arrears-snapshot"

const row = (over: Partial<SnapshotRow> = {}): SnapshotRow => ({
  status: "ACTIVE", ncaRegime: "NCA", collectionsStage: "NONE", daysInArrears: 0, arrearsCents: 0,
  outstandingPrincipalCents: 100_00, chargesOutstandingCents: 0, chargesLive: false, ...over,
})

describe("snapshotDay", () => {
  it("is the SAST calendar day, not the UTC one", () => {
    // 23:30 SAST on 30 Sep is 21:30 UTC; 00:30 SAST on 1 Oct is 22:30 UTC on 30 Sep.
    expect(snapshotDay(new Date("2026-09-30T21:30:00Z")).toISOString()).toBe("2026-09-30T00:00:00.000Z")
    expect(snapshotDay(new Date("2026-09-30T22:30:00Z")).toISOString()).toBe("2026-10-01T00:00:00.000Z")
  })
})

describe("bookArrearsFromSnapshot (book-arrears definitions)", () => {
  it("counts in arrears only past due AND unpaid AND principal owed", () => {
    const book = bookArrearsFromSnapshot([
      row({ daysInArrears: 5, arrearsCents: 10_00 }),
      row({ daysInArrears: 5, arrearsCents: 0 }), // stale DPD, nothing owed
      row({ daysInArrears: 5, arrearsCents: 10_00, outstandingPrincipalCents: 0 }), // repaid
    ], "ALL")
    expect(book.arrears).toEqual({ count: 1, amount: 10_00, outstandingPrincipal: 100_00 })
  })

  it("puts day 90 in the 90+ band and PAR90", () => {
    const book = bookArrearsFromSnapshot([row({ daysInArrears: 90, arrearsCents: 1 }), row({ daysInArrears: 89, arrearsCents: 1 })], "ALL")
    expect(book.par90.count).toBe(1)
    expect(book.ageing.find((b) => b.label === "90+ DPD")!.count).toBe(1)
    expect(book.ageing.find((b) => b.label === "61-89 DPD")!.count).toBe(1)
    expect(book.par30.pct).toBe(100)
  })

  it("adds default charges to arrears and counts charges-only loans only while charges are live", () => {
    const rows = [row({ daysInArrears: 5, arrearsCents: 10_00, chargesOutstandingCents: 2_00 }), row({ chargesOutstandingCents: 3_00 })]
    expect(bookArrearsFromSnapshot(rows, "ALL")).toMatchObject({ arrears: { amount: 10_00 }, chargesOnly: { count: 0, amount: 0 } })
    const live = rows.map((r) => ({ ...r, chargesLive: true }))
    expect(bookArrearsFromSnapshot(live, "ALL")).toMatchObject({ arrears: { amount: 12_00 }, chargesOnly: { count: 1, amount: 3_00 } })
  })

  it("scopes NCA, and leaves settled loans out of the book", () => {
    const rows = [row(), row({ ncaRegime: "NON_NCA" }), row({ status: "COMPLETED" })]
    expect(bookArrearsFromSnapshot(rows, "NCA").book.count).toBe(1)
    expect(bookArrearsFromSnapshot(rows, "ALL").book.count).toBe(2)
  })
})

describe("snapshotTenantArrears", () => {
  it("derives DPD and arrears from the schedule as of the run and inserts idempotently", async () => {
    const createMany = vi.fn(async () => ({ count: 1 }))
    const runCreateMany = vi.fn(async () => ({ count: 1 }))
    const db = {
      tenantConfig: { findUnique: vi.fn(async () => null) },
      loan: { findMany: vi.fn(async () => [{
        id: "l1", status: "ACTIVE", ncaRegime: "NCA", collectionsStage: "NONE", principal: 3_400_000,
        outstandingPrincipal: 2_713_391, chargesOutstanding: 0,
        repaymentSchedule: [
          { dueDate: new Date("2026-09-17T06:30:01Z"), principalDue: 289_000, interestDue: 50_000, feesDue: 0, totalDue: 339_000, totalPaid: 254_670 },
          { dueDate: new Date("2026-10-17T06:30:01Z"), principalDue: 289_000, interestDue: 50_000, feesDue: 0, totalDue: 339_000, totalPaid: 0 },
        ],
      }]) },
      loanArrearsSnapshot: { createMany },
      arrearsSnapshotRun: { createMany: runCreateMany },
    } as unknown as Parameters<typeof snapshotTenantArrears>[2]
    const result = await snapshotTenantArrears("t1", new Date("2026-10-16T21:45:00Z"), db)
    expect(result).toEqual({ snapshotDate: "2026-10-16", loans: 1, written: 1 })
    expect(createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({
        tenantId: "t1", loanId: "l1", snapshotDate: new Date("2026-10-16T00:00:00.000Z"),
        daysInArrears: 29, arrearsCents: 84_330, outstandingPrincipalCents: 2_713_391, chargesLive: false,
      })],
      skipDuplicates: true,
    })
    // The day's run marker, after the rows: an empty book still records a run.
    expect(runCreateMany).toHaveBeenCalledWith({
      data: [{ tenantId: "t1", snapshotDate: new Date("2026-10-16T00:00:00.000Z"), loanCount: 1 }],
      skipDuplicates: true,
    })
    expect(runCreateMany.mock.invocationCallOrder[0]).toBeGreaterThan(createMany.mock.invocationCallOrder[0])
  })
})
