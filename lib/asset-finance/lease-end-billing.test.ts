import { describe, expect, it, vi } from "vitest"
import { dbDate } from "./dates"
import { billingRefusal } from "./lease-end-billing"

interface World { lastDue?: string; pendingDue?: string; openClaim?: boolean; valuedOn?: string }

function tx(w: World) {
  return {
    leaseRental: {
      findFirst: vi.fn(async (args: { where: { taxInvoiceId?: null } }) => {
        const due = "taxInvoiceId" in args.where ? w.pendingDue : w.lastDue
        return due ? { dueDate: dbDate(due) } : null
      }),
    },
    assetFinanceDeal: { findFirst: vi.fn(async () => ({ rentalTiming: "ARREARS" })) },
    assetValuation: { findFirst: vi.fn(async () => (w.valuedOn ? { valuedOn: dbDate(w.valuedOn), amountCents: 1, source: "ASSESSOR", createdById: "valuer" } : null)) },
    tenantConfig: { findUnique: vi.fn(async () => ({ leasePurchaseValuationMaxAgeDays: 30 })) },
    maintenanceClaim: { findFirst: vi.fn(async () => (w.openClaim ? { id: "c1" } : null)) },
  }
}
type Row = Parameters<typeof billingRefusal>[1]["row"]
const ret: Row = { outcome: "RETURN", assetId: "a1", purchaseValuationId: null, inspectedById: "inspector", damageItems: [] }
const sale: Row = { ...ret, outcome: "PURCHASE", purchaseValuationId: "v1", inspectedById: null }
const refusal = (w: World, row: Row, actorUserId = "biller") =>
  billingRefusal(tx(w) as never, { tenantId: "t1", loanId: "l1", today: "2027-06-30", actorUserId, row }).then((r) => r?.reason ?? null)

describe("billingRefusal (C7–C8): what holds before an end of term is billed", () => {
  it("a return, every rental invoiced, no claim open, billed by someone other than the inspector: nothing in the way", async () => {
    expect(await refusal({ lastDue: "2027-06-30" }, { ...ret, damageItems: [{}] })).toBeNull()
  })
  it("rentals_pending: an uncancelled rental without its tax invoice", async () => {
    expect(await refusal({ pendingDue: "2027-06-30" }, ret)).toBe("rentals_pending")
  })
  it("open_claims: a submitted or approved maintenance claim", async () => {
    expect(await refusal({ openClaim: true }, ret)).toBe("open_claims")
  })
  it("four_eyes: assessed damage is not billed by its inspector; without damage the inspector may bill", async () => {
    expect(await refusal({}, { ...ret, damageItems: [{}] }, "inspector")).toBe("four_eyes")
    expect(await refusal({}, ret, "inspector")).toBeNull()
  })
  it("a purchase: sold from the term's end (on it: billed), on a valuation it names, still current", async () => {
    expect(await refusal({ lastDue: "2027-07-01", valuedOn: "2027-06-30" }, sale)).toBe("term_running")
    expect(await refusal({ lastDue: "2027-06-30", valuedOn: "2027-06-30" }, sale)).toBeNull()
    expect(await refusal({ lastDue: "2027-06-30" }, { ...sale, purchaseValuationId: null })).toBe("purchase_terms")
    expect(await refusal({ lastDue: "2027-06-30", valuedOn: "2027-05-30" }, sale)).toBe("valuation_stale")
    expect(await refusal({ lastDue: "2027-06-30", valuedOn: "2027-05-31" }, sale)).toBeNull()
  })
})
