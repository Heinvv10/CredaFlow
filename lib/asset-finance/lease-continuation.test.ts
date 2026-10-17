import { expect, it, vi } from "vitest"
import { runCpaContinuations } from "./lease-daily"
vi.mock("@/lib/audit", () => ({ AuditAction: { LEASE_END_OF_TERM_ELECTED: "LEASE_END_OF_TERM_ELECTED" }, logAuditStrict: vi.fn() }))
it("continues an expired CPA lease without an election, including defaulted and paid-up leases", async () => {
  const create = vi.fn(async () => ({ id: "end1" }))
  const db = {
    loan: { findMany: vi.fn(async () => [{ id: "l1", maturityDate: new Date("2026-10-01"), assetFinanceDeal: { rentalTiming: "ARREARS" } }]) },
    $transaction: async (run: (tx: unknown) => Promise<unknown>) => run({
      $queryRaw: vi.fn(), loan: { findFirst: vi.fn(async () => ({ leaseEndOfTerm: null })) }, leaseEndOfTerm: { create },
    }),
  }
  await runCpaContinuations(db as never, "t1", "2026-10-17", { extensionRentals: 0, expiryNotices: 0, failed: 0 })
  expect(create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ loanId: "l1", outcome: "EXTEND", status: "EXTENDING" }) }))
  expect(db.loan.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ cpaApplies: true, status: { in: ["ACTIVE", "COMPLETED", "DEFAULTED"] } }) }))
})
