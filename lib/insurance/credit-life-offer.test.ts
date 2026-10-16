import { describe, expect, it } from "vitest"
import { creditLifeOfferFindFirstArgs } from "./credit-life-offer"

describe("creditLifeOfferFindFirstArgs", () => {
  it("only offers a same-tenant active product backed by a same-tenant active insurer", () => {
    expect(creditLifeOfferFindFirstArgs("tenant-1")).toMatchObject({
      where: {
        tenantId: "tenant-1",
        type: "CREDIT_LIFE",
        active: true,
        insurerId: { not: null },
        insurer: {
          is: {
            tenantId: "tenant-1",
            active: true,
          },
        },
      },
    })
  })

  it("skips a product whose configured premium or cover is not positive", () => {
    expect(creditLifeOfferFindFirstArgs("tenant-1").where).toMatchObject({
      premiumAmount: { gt: 0 },
      sumAssured: { gt: 0 },
    })
  })

  it("selects deterministically when more than one supported offer exists", () => {
    expect(creditLifeOfferFindFirstArgs("tenant-1").orderBy).toEqual([
      { createdAt: "asc" },
      { id: "asc" },
    ])
  })

  // #143 blind review (HIGH): a lender with no FSP number issues no insurance,
  // so every place that presents or records an offer sees none.
  it("offers nothing for a lender that holds no FSP number", () => {
    expect(creditLifeOfferFindFirstArgs("tenant-1").where.tenant).toEqual({
      config: { is: { AND: [{ fscaNumber: { not: null } }, { NOT: { fscaNumber: "" } }] } },
    })
  })
})
