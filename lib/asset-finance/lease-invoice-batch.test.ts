import { describe, expect, it, vi } from "vitest"

const { issue } = vi.hoisted(() => ({ issue: vi.fn() }))
vi.mock("./lease-invoices", () => ({ issueLeaseRentalInvoice: issue }))

import { runLeaseInvoiceBatch } from "./lease-invoice-batch"

describe("runLeaseInvoiceBatch", () => {
  it("asks only tenants with asset finance on, counts each outcome, and keeps going past a failing rental", async () => {
    const tenants = vi.fn(async () => [{ tenantId: "t1" }])
    const due = [{ id: "r1", dueDate: new Date("2027-01-01T00:00:00Z") }, { id: "r2", dueDate: new Date("2027-02-01T00:00:00Z") }, { id: "r3", dueDate: new Date("2027-03-01T00:00:00Z") }]
    const db = {
      tenantConfig: { findMany: tenants },
      leaseRental: { findMany: vi.fn(async () => due) },
      leaseEndOfTerm: { findMany: vi.fn(async () => []) }, // no extensions running (lease-daily.ts; ITs cover them)
      loan: { findMany: vi.fn(async () => []) }, // no expiry notice due
      $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({})),
    }
    issue.mockReset()
      .mockResolvedValueOnce({ kind: "issued", invoiceId: "i1", invoiceNumber: "INV-1" })
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({ kind: "refused", reason: "vat_rate_changed", error: "x" })
    const run = await runLeaseInvoiceBatch(db as never, "2027-03-02")
    expect(tenants).toHaveBeenCalledWith(expect.objectContaining({ where: { featureAssetFinance: true } }))
    expect(run).toMatchObject({ ok: false, issued: 1, failed: 1, refused: { vat_rate_changed: 1 }, extensionRentals: 0, expiryNotices: 0 })
    expect(issue).toHaveBeenCalledTimes(3)
    expect(issue.mock.calls[0][1]).toMatchObject({ rentalId: "r1", supplyDate: "2027-01-01", source: "cron" })
  })
})
