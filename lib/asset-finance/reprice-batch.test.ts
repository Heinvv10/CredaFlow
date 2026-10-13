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
    referenceRate: { findMany: vi.fn(async () => [{ basis: "PRIME", effectiveDate: new Date("2027-01-15T00:00:00Z") }]) },
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
      ["l1", "l2", "l3", "l4"].map((loanId) => ({ tenantId: "t1", loanId, basis: "PRIME", effectiveDate: "2027-01-15", runDate: "2027-01-16" })),
    )
    expect(run).toEqual({
      ok: false,
      day: "2027-01-16",
      perTenant: [{ tenantId: "t1", repriced: 1, alreadyRepriced: 1, notEligible: { superseded: 1 }, failed: 1 }],
    })
    expect(consoleError).toHaveBeenCalledTimes(1)
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
    expect(fakes.tenantConfig.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { featureAssetFinance: true } }))
    expect(fakes.referenceRate.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { tenantId: "t1", status: "APPROVED", effectiveDate: { lte: new Date("2027-01-16T00:00:00.000Z") } },
    }))
    const effectiveDate = new Date("2027-01-15T00:00:00.000Z")
    expect(fakes.loan.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        tenantId: "t1",
        status: "ACTIVE",
        contractType: { not: "LOAN" },
        contractRates: { some: { basis: "PRIME", effectiveDate: { lt: effectiveDate } }, none: { effectiveDate } },
      },
    }))
  })
})
