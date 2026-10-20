import { describe, it, expect, vi, beforeEach } from "vitest"

// vi.mock factories run when route.ts's own `import` statements resolve, which
// (per ES module evaluation order) happens before this file's top-level `const`
// statements run. Referencing a plain `const` from inside a factory therefore
// hits the TDZ. vi.hoisted() is vitest's documented fix: it hoists the
// declaration itself alongside the mock registration.
const { reverse, findMany, updateMany, recomputeLoanBalances, tenants } = vi.hoisted(() => ({
  tenants: [{ id: "t1", name: "One" }],
  reverse: vi.fn(),
  findMany: vi.fn(),
  updateMany: vi.fn().mockResolvedValue({ count: 1 }),
  recomputeLoanBalances: vi.fn(() => ({ daysInArrears: 95, arrearsAmount: 12345 })),
}))
vi.mock("@/lib/referral-agents/commission", () => ({ reverseReferralCommissionForLoan: reverse }))
vi.mock("@/lib/cron-auth", () => ({ verifyCronSecret: () => null }))
vi.mock("@/lib/loan/balances", () => ({ recomputeLoanBalances }))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    tenant: { findMany: async () => tenants },
    loan: { findMany: (a: unknown) => findMany(a), updateMany },
    cronRunClaim: { upsert: vi.fn() },
  },
}))

import { runDpdUpdate } from "@/lib/loan/dpd-update"
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

  describe("several tenants", () => {
    const two = [{ id: "t1", name: "One" }, { id: "t2", name: "Two" }]
    const run = (which = two) => { tenants.splice(0, tenants.length, ...which); return runDpdUpdate() }

    it("reports a tenant that threw, without the cause, and still runs the next", async () => {
      vi.spyOn(console, "error").mockImplementation(() => undefined)
      findMany.mockImplementation(async (a: { where: { tenantId: string } }) => {
        if (a.where.tenantId === "t1") throw new Error("postgres://secret")
        return [{ id: "L9", status: "ACTIVE", principal: 1, daysInArrears: 0, arrearsAmount: 0, repaymentSchedule: [] }]
      })
      const r = await run()
      expect(r.failedTenants).toBe(1)
      expect(r.perTenant).toEqual([{ tenantId: "t1", error: "failed; see the server log" }, { tenantId: "t2", processed: 1, updated: 1, skipped: 0 }])
      expect(JSON.stringify(r)).not.toContain("secret")
      expect(updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "L9", tenantId: "t2" } }))
      tenants.splice(0, tenants.length, { id: "t1", name: "One" })
    })

    it("the route answers 200 partial for one failed tenant and 503 when all failed", async () => {
      vi.spyOn(console, "error").mockImplementation(() => undefined)
      tenants.splice(0, tenants.length, ...two)
      findMany.mockImplementation(async (a: { where: { tenantId: string } }) => {
        if (a.where.tenantId === "t1") throw new Error("boom")
        return []
      })
      const partial = await GET(new Request("http://x/api/cron/dpd-update") as never)
      expect(partial.status).toBe(200)
      expect(await partial.json()).toMatchObject({ ok: true, partial: true, failedTenants: 1 })
      findMany.mockRejectedValue(new Error("boom"))
      expect((await GET(new Request("http://x/api/cron/dpd-update") as never)).status).toBe(503)
      tenants.splice(0, tenants.length, { id: "t1", name: "One" })
    })
  })
})
