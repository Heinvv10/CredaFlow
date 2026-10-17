import { expect, it, vi } from "vitest"
vi.mock("@/lib/prisma", () => ({ prisma: {} }))
vi.mock("@/lib/audit", () => ({
  AuditAction: { LEASE_RENTAL_INVOICED: "LEASE_RENTAL_INVOICED" },
  logAuditStrict: vi.fn(),
}))
vi.mock("@/lib/vat/credit-note", () => ({ issueCreditNote: vi.fn() }))
vi.mock("@/lib/vat/tax-invoice", () => ({ issueTaxInvoice: vi.fn() }))
import { issueCreditNote } from "@/lib/vat/credit-note"
import { issueTaxInvoice } from "@/lib/vat/tax-invoice"
import { consumeDeferredLeaseRateTax, amendedLeaseRentals } from "./lease-rate-tax-adjustment"
function setup(rentalExclVatCents = 0) {
  const events: Array<{ cause: string; reason: string; contractualRows: unknown; amountCents: number }> = []
  const source = {
    id: "old-rate",
    contractRateId: "old-contract-rate",
    reason: "LATE_CLOSED_LEASE_RATE",
    contractRate: { effectiveDate: new Date("2026-10-01Z") },
    contractualRows: {
      periodAdjustments: [{ periodNo: 60, exclVatCents: -1000 }],
      pendingTaxAdjustments: [{ rentalId: "rental-60", periodNo: 60, exclVatCents: -1000, estimatedGrossCents: -1150 }],
    },
  }
  const create = vi.fn(async ({ data }) => {
    events.push(data)
    return data
  })
  const tx = {
    assetFinanceRateCorrection: {
      findMany: vi.fn(async () => [source, ...events]),
      findUnique: vi.fn(async ({ where }) => events.find((event) => event.cause === where.cause)),
      aggregate: vi.fn(async () => ({ _sum: { amountCents: -1150 } })),
      create,
    },
    leaseRental: {
      findFirstOrThrow: vi.fn(async () => ({
        taxInvoiceId: null,
        cancelledAt: null,
        dueDate: new Date("2026-11-01Z"),
        rentalExclVatCents,
      })),
    },
    assetFinanceRateNotice: { findFirst: vi.fn(async () => null) },
  }
  return { tx, events, create }
}
it("consumes a superseded unmade rental adjustment once without inventing a supply or stale CN", async () => {
  const { tx, events, create } = setup()
  const input = {
    tenantId: "synthetic",
    loanId: "loan",
    rentalIds: ["rental-60"],
    today: "2026-10-18",
    actorUserId: null,
    replacedByRentalFloor: true,
  }
  await consumeDeferredLeaseRateTax(tx as never, input)
  await consumeDeferredLeaseRateTax(tx as never, input)
  expect(create).toHaveBeenCalledTimes(1)
  expect(events[0]).toMatchObject({
    reason: "LEASE_SUPPLY_TAX_CANCELLED",
    amountCents: 1150,
    contractualRows: { replacedByRentalFloor: true, exclVatAdjustmentCents: 1000, taxDocuments: [] },
  })
  expect(
    await amendedLeaseRentals(tx as never, "synthetic", "loan", [{ periodNo: 60, rentalExclVatCents: 0 }])
  ).toEqual([{ periodNo: 60, rentalExclVatCents: 0 }])
  expect(issueCreditNote).not.toHaveBeenCalled()
  expect(issueTaxInvoice).not.toHaveBeenCalled()
})
it("requires the future rental actually to have been set to zero", async () => {
  const { tx } = setup(1000)
  await expect(
    consumeDeferredLeaseRateTax(tx as never, {
      tenantId: "synthetic",
      loanId: "loan",
      rentalIds: ["rental-60"],
      today: "2026-10-18",
      actorUserId: null,
      replacedByRentalFloor: true,
    })
  ).rejects.toThrow("unmade rental supply")
})
