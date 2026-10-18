import { expect, it, vi } from "vitest"
import { completeEndOfTermIfSettled } from "./lease-end-invoice"
it("does not close a returned lease while its unilateral cancellation charge still awaits assessment", async () => {
  const update = vi.fn()
  const tx = { leaseEndOfTerm: { findFirst: vi.fn(async () => ({ id: "e1", outcome: "RETURN", loan: { status: "ACTIVE", assetId: null, asset: null, repaymentSchedule: [], leaseTerminationQuotes: [{ id: "q1" }] } })), update } }
  expect(await completeEndOfTermIfSettled(tx as never, { tenantId: "t1", loanId: "l1", userId: "u1" })).toBe(false)
  expect(update).not.toHaveBeenCalled()
})
