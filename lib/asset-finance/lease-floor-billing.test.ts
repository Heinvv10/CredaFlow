import { describe, expect, it, vi } from "vitest"
import { billingRefusal } from "./lease-end-billing"

type Rental = { rentalExclVatCents: number; maintenanceExclVatCents: number }
type Clause = { rentalExclVatCents?: { gt: number }; maintenanceExclVatCents?: { gt: number } }

function transaction(rental: Rental) {
  return {
    leaseRental: { findFirst: vi.fn(async ({ where }: { where: { OR?: Clause[] } }) => {
      const matches = !where.OR || where.OR.some((clause) => Object.entries(clause).every(([field, filter]) => rental[field as keyof Rental] > filter.gt))
      return matches ? { dueDate: new Date("2026-10-01T00:00:00Z") } : null
    }) },
    maintenanceClaim: { findFirst: vi.fn(async () => null) },
  }
}

const input = { tenantId: "synthetic-tenant", loanId: "synthetic-lease", today: "2026-10-18", actorUserId: "synthetic-biller",
  row: { outcome: "RETURN", assetId: "synthetic-asset", purchaseValuationId: null, inspectedById: null, damageItems: [] } }

describe("lease floor and end-of-term billing", () => {
  it("can finish billing when the only uninvoiced rental has no consideration", async () => {
    expect(await billingRefusal(transaction({ rentalExclVatCents: 0, maintenanceExclVatCents: 0 }) as never, input)).toBeNull()
  })
  it.each([{ rentalExclVatCents: 100, maintenanceExclVatCents: 0 }, { rentalExclVatCents: 0, maintenanceExclVatCents: 100 }])("still requires the positive rental or maintenance supply invoice: %j", async (rental) => {
    expect(await billingRefusal(transaction(rental) as never, input)).toMatchObject({ reason: "rentals_pending" })
  })
})
