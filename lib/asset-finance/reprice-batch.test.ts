import { afterEach, describe, expect, it, vi } from "vitest"

const { repriceLoanForReference } = vi.hoisted(() => ({ repriceLoanForReference: vi.fn() }))
vi.mock("./reprice-loan", () => ({ repriceLoanForReference }))

import { runRepriceBatch } from "./reprice-batch"

// The sweep's bookkeeping with the database faked: one transaction per loan,
// a failure counted and logged without stopping the rest. The real-database
// behaviour (selection, idempotent re-run) is in reprice-loan.integration.test.ts.

type BatchDb = Parameters<typeof runRepriceBatch>[0]

function fakeDb(loanIds: string[]) {
  const transaction = vi.fn(async (fn: (tx: string) => Promise<unknown>) => fn("tx"))
  const fakes = {
    tenantConfig: { findMany: vi.fn(async () => [{ tenantId: "t1" }]) },
    referenceRate: {
      findMany: vi.fn(async () => [{ basis: "PRIME", effectiveDate: new Date("2027-01-15T00:00:00Z") }]),
    },
    loan: { findMany: vi.fn(async () => loanIds.map((id) => ({ id }))) },
    $transaction: transaction,
  }
  return { db: fakes as unknown as BatchDb, transaction, fakes }
}

describe("runRepriceBatch", () => {
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined)
  afterEach(() => {
    repriceLoanForReference.mockReset()
    consoleError.mockClear()
  })

  it("runs each loan in its own transaction and goes on after one fails", async () => {
    repriceLoanForReference
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({ kind: "repriced" })
      .mockResolvedValueOnce({ kind: "not_eligible", reason: "superseded" })
      .mockResolvedValueOnce({ kind: "already_repriced" })
    const { db, transaction } = fakeDb(["l1", "l2", "l3", "l4"])

    const run = await runRepriceBatch(db, "2027-01-16")

    expect(transaction).toHaveBeenCalledTimes(4)
    expect(repriceLoanForReference.mock.calls.map(([, request]) => request)).toEqual(
      ["l1", "l2", "l3", "l4"].map((loanId) => ({
        tenantId: "t1",
        loanId,
        basis: "PRIME",
        effectiveDate: "2027-01-15",
        runDate: "2027-01-16",
      }))
    )
    expect(run).toEqual({
      ok: false,
      day: "2027-01-16",
      perTenant: [{ tenantId: "t1", repriced: 1, alreadyRepriced: 1, notEligible: { superseded: 1 }, failed: 1 }],
    })
    expect(consoleError).toHaveBeenCalledTimes(1)
  })

  it("defers later reference changes for a loan whose earlier change failed", async () => {
    repriceLoanForReference
      .mockRejectedValueOnce(new Error("temporary failure"))
      .mockResolvedValue({ kind: "repriced" })
    const { db, fakes } = fakeDb(["l1", "l2"])
    fakes.referenceRate.findMany.mockResolvedValue([
      { basis: "PRIME", effectiveDate: new Date("2027-01-10T00:00:00Z") },
      { basis: "PRIME", effectiveDate: new Date("2027-01-15T00:00:00Z") },
    ])

    const run = await runRepriceBatch(db, "2027-01-16")

    expect(repriceLoanForReference.mock.calls.map(([, request]) => request)).toEqual([
      expect.objectContaining({ loanId: "l1", effectiveDate: "2027-01-10" }),
      expect.objectContaining({ loanId: "l2", effectiveDate: "2027-01-10" }),
      expect.objectContaining({ loanId: "l2", effectiveDate: "2027-01-15" }),
    ])
    expect(run).toMatchObject({ ok: false, perTenant: [{ repriced: 2, failed: 1 }] })
  })

  it("counts a balloon_reached loan as not eligible, not a failure, so the cron stays 200", async () => {
    repriceLoanForReference.mockResolvedValue({ kind: "not_eligible", reason: "balloon_reached" })
    const run = await runRepriceBatch(fakeDb(["l1"]).db, "2027-01-16")
    expect(run).toMatchObject({ ok: true, perTenant: [{ notEligible: { balloon_reached: 1 }, failed: 0 }] })
    expect(consoleError).not.toHaveBeenCalled()
  })

  it("is ok when nothing failed", async () => {
    repriceLoanForReference.mockResolvedValue({ kind: "repriced" })
    const run = await runRepriceBatch(fakeDb(["l1"]).db, "2027-01-16")
    expect(run.ok).toBe(true)
  })

  it("selects only flagged tenants, APPROVED references up to the day, and ACTIVE asset-finance loans linked to the basis", async () => {
    repriceLoanForReference.mockResolvedValue({ kind: "repriced" })
    const { db, fakes } = fakeDb(["l1"])
    await runRepriceBatch(db, "2027-01-16")
    expect(fakes.tenantConfig.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { featureAssetFinance: true } })
    )
    expect(fakes.referenceRate.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId: "t1", status: "APPROVED", effectiveDate: { lte: new Date("2027-01-16T00:00:00.000Z") } },
      })
    )
    const effectiveDate = new Date("2027-01-15T00:00:00.000Z")
    expect(fakes.loan.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          tenantId: "t1",
          status: { in: ["ACTIVE", "COMPLETED"] },
          contractType: { not: "LOAN" },
          contractRates: { some: { basis: "PRIME", effectiveDate: { lt: effectiveDate } }, none: { effectiveDate } },
        },
      })
    )
  })
})

it("dispatches each notice only after its financial transaction commits", async () => {
  repriceLoanForReference.mockResolvedValue({ kind: "repriced" })
  const { db, transaction } = fakeDb(["l1", "l2"])
  const events: string[] = []
  transaction.mockImplementation(async (fn) => {
    const result = await fn("tx")
    events.push("commit")
    return result
  })
  await runRepriceBatch(db, "2027-01-16", async (tenantId) => {
    expect(tenantId).toBe("t1")
    events.push("dispatch")
  })
  expect(events).toEqual(["commit", "dispatch", "commit", "dispatch"])
})
