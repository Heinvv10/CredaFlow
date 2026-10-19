import { describe, expect, it, vi } from "vitest"

// The dealer's commission statement reads only its own lender's and dealer's
// lines and runs, and never asks for a run's bank account, its staff actors,
// or a line's base (the approved financed amount).
const S = "SENTINEL-LEAK"
const h = vi.hoisted(() => ({ lines: vi.fn(), runs: vi.fn() }))
vi.mock("@/lib/prisma", () => ({ prisma: { dealerCommissionLine: { findMany: h.lines }, dealerPayableRun: { findMany: h.runs } } }))

import { loadDealerCommissionStatement } from "./commission-statement"

const keysOf = (value: unknown, out: string[] = []): string[] => {
  if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) { out.push(k); keysOf(v, out) }
  return out
}

describe("loadDealerCommissionStatement", () => {
  it("filters on the dealer, totals the lines, and carries no bank, staff or base column", async () => {
    h.lines.mockResolvedValue([
      { id: "l1", kind: "EARNED", reason: null, effectiveOn: new Date("2026-10-05T00:00:00Z"), netCents: 1000, vatCents: 150, grossCents: 1150, dealId: "d1",
        deal: { application: { reference: "AF-1" } }, loan: { reference: "LN-1" }, runLinks: [{ runId: "r1" }], baseCents: S, bankAccountId: S },
      { id: "l2", kind: "REVERSED", reason: "LOAN_CANCELLED", effectiveOn: new Date("2026-10-06T00:00:00Z"), netCents: -1000, vatCents: -150, grossCents: -1150, dealId: "d1",
        deal: { application: { reference: "AF-1" } }, loan: { reference: "LN-1" }, runLinks: [] },
    ])
    h.runs.mockResolvedValue([{
      id: "r1", periodEnd: new Date("2026-10-31T00:00:00Z"), status: "RELEASED", totalNetCents: 1000, totalVatCents: 150, totalGrossCents: 1150,
      createdAt: new Date(), approvedAt: new Date(), releasedAt: new Date(), releaseReference: "EFT-1", cancelledAt: null,
      bankAccountId: S, approvedById: S, createdById: S,
    }])
    const statement = await loadDealerCommissionStatement({ tenantId: "tenant-1", dealerId: "dealer-1" })
    for (const call of [h.lines.mock.calls[0][0], h.runs.mock.calls[0][0]]) {
      expect(call.where).toEqual({ tenantId: "tenant-1", dealerId: "dealer-1" })
      const asked = keysOf(call.select)
      for (const key of ["bankAccount", "bankAccountId", "createdById", "approvedById", "releasedById", "cancelledById", "baseCents", "bps", "flatCents"]) {
        expect(asked, key).not.toContain(key)
      }
    }
    expect(JSON.stringify(statement)).not.toContain(S)
    expect(statement.totals).toEqual({ earnedNetCents: 1000, reversedNetCents: -1000, netCents: 0, grossCents: 0 })
    expect(statement.lines[0]).toMatchObject({ dealReference: "AF-1", loanReference: "LN-1", runId: "r1", effectiveOn: "2026-10-05" })
    expect(statement.runs[0]).toMatchObject({ periodEnd: "2026-10-31", status: "RELEASED", releaseReference: "EFT-1" })
  })
})
