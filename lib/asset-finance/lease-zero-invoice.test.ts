import { expect, it, vi } from "vitest"
vi.mock("@/lib/prisma", () => ({ prisma: {} }))
vi.mock("@/lib/vat/tax-invoice", () => ({ issueTaxInvoice: vi.fn(), describeAsset: vi.fn() }))
import { issueTaxInvoice } from "@/lib/vat/tax-invoice"
import { issueLeaseRentalInvoice } from "./lease-invoices"
it("does not create or number a tax invoice for a zero rental without maintenance", async () => {
  const tx = {
    $queryRaw: vi.fn(async () => [{ id: "zero-rental" }]),
    leaseRental: {
      findFirst: vi.fn(async () => ({
        id: "zero-rental",
        taxInvoiceId: null,
        cancelledAt: null,
        dueDate: new Date("2026-11-01Z"),
        rentalExclVatCents: 0,
        maintenanceExclVatCents: 0,
      })),
    },
  }
  const input = {
    tenantId: "synthetic",
    rentalId: "zero-rental",
    supplyDate: "2026-11-01",
    today: "2026-11-01",
    createdById: null,
    source: "cron" as const,
  }
  expect(await issueLeaseRentalInvoice(tx as never, input)).toEqual({ kind: "no_charge" })
  expect(await issueLeaseRentalInvoice(tx as never, input)).toEqual({ kind: "no_charge" })
  expect(issueTaxInvoice).not.toHaveBeenCalled()
})
