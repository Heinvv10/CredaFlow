import { Prisma } from "@prisma/client"
import { describe, expect, it, vi } from "vitest"
import { creditLifeBundleFor } from "./booking-credit-life"

// #143 blind review (HIGH): asset-finance booking bound a CREDIT_LIFE policy
// for a lender with no FSP number. A lender without one issues no insurance.
const product = { id: "cl-1", insurerId: "ins-1", commissionRate: new Prisma.Decimal("0.1") }
const tx = (fscaNumber: string | null) => ({
  insuranceProduct: { findFirst: vi.fn().mockResolvedValue(product) },
  tenantConfig: { findUnique: vi.fn().mockResolvedValue({ fscaNumber }) },
})
const application = { creditLifeProductId: "cl-1", creditLifeMonthlyPremiumCents: 13_500 }

describe("creditLifeBundleFor", () => {
  it("binds accepted cover for a lender that holds an FSP number", async () => {
    expect(await creditLifeBundleFor(tx("12345"), "t1", true, application, { id: "c1" })).toEqual({
      bundle: { clientId: "c1", productId: "cl-1", insurerId: "ins-1", commissionRate: product.commissionRate, premiumAmount: 135 },
    })
  })

  it.each([[null], [""]])("refuses to bind for a lender whose FSP number is %j", async (fscaNumber) => {
    expect(await creditLifeBundleFor(tx(fscaNumber), "t1", true, application, { id: "c1" })).toMatchObject({ reason: "credit_life_no_fsp" })
  })

  it("binds nothing, and reads nothing, when cover was not accepted", async () => {
    const reader = tx(null)
    expect(await creditLifeBundleFor(reader, "t1", false, application, { id: "c1" })).toEqual({ bundle: null })
    expect(reader.tenantConfig.findUnique).not.toHaveBeenCalled()
  })
})
