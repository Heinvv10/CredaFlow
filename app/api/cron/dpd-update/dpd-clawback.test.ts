import { describe, it, expect, vi, beforeEach } from "vitest"

// vi.mock factories run when route.ts's own `import` statements resolve, which
// (per ES module evaluation order) happens before this file's top-level `const`
// statements run. Referencing a plain `const` from inside a factory therefore
// hits the TDZ. vi.hoisted() is vitest's documented fix: it hoists the
// declaration itself alongside the mock registration.
const { reverse, findMany, updateMany, recomputeLoanBalances } = vi.hoisted(() => ({
  reverse: vi.fn(),
  findMany: vi.fn(),
  updateMany: vi.fn().mockResolvedValue({ count: 1 }),
  recomputeLoanBalances: vi.fn(() => ({ daysInArrears: 95, arrearsAmount: 12345 })),
}))
vi.mock("@/lib/referral-agents/commission", () => ({ reverseReferralCommissionForLoan: reverse }))
vi.mock("@/lib/cron-auth", () => ({ verifyCronSecret: () => null }))
vi.mock("@/lib/loan/balances", () => ({ recomputeLoanBalances }))
vi.mock("@/lib/prisma", () => ({
  prisma: { tenant: { findMany: async () => [{ id: "t1", name: "One" }] }, loan: { findMany: (a: unknown) => findMany(a), updateMany } },
}))

import { GET } from "./route"

beforeEach(() => {
  reverse.mockClear()
  updateMany.mockClear()
  recomputeLoanBalances.mockClear()
  recomputeLoanBalances.mockReturnValue({ daysInArrears: 95, arrearsAmount: 12345 })
})

describe("dpd-update clawback", () => {
  it("reverses commission when an ACTIVE loan crosses 90 DPD", async () => {
    findMany.mockResolvedValue([{ id: "L1", status: "ACTIVE", principal: 500_000, daysInArrears: 40, arrearsAmount: 1, repaymentSchedule: [] }])
    await GET(new Request("http://x/api/cron/dpd-update") as never)
    expect(reverse).toHaveBeenCalledWith(expect.anything(), { tenantId: "t1", loanId: "L1" })
  })

  // Self-healing: the transition guard was removed because reverse() is idempotent
  // (only flips PENDING/PAYABLE -> REVERSED, matches 0 rows once done). An
  // already-DEFAULTED loan still gets daysInArrears incremented every night, so it
  // always reaches this call — meaning a prior run's clawback failure retries
  // harmlessly on the next run instead of silently never healing.
  it("STILL reverses an already-DEFAULTED loan re-computing to >=90 DPD (idempotent retry)", async () => {
    findMany.mockResolvedValue([{ id: "L2", status: "DEFAULTED", principal: 500_000, daysInArrears: 40, arrearsAmount: 1, repaymentSchedule: [] }])
    await GET(new Request("http://x/api/cron/dpd-update") as never)
    expect(reverse).toHaveBeenCalledWith(expect.anything(), { tenantId: "t1", loanId: "L2" })
  })

  it("does NOT reverse a loan computing to below 90 DPD", async () => {
    recomputeLoanBalances.mockReturnValueOnce({ daysInArrears: 40, arrearsAmount: 1 })
    findMany.mockResolvedValue([{ id: "L3", status: "ACTIVE", principal: 500_000, daysInArrears: 10, arrearsAmount: 1, repaymentSchedule: [] }])
    await GET(new Request("http://x/api/cron/dpd-update") as never)
    expect(reverse).not.toHaveBeenCalled()
  })
})
