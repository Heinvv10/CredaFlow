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

  it("selects deterministically when more than one supported offer exists", () => {
    expect(creditLifeOfferFindFirstArgs("tenant-1").orderBy).toEqual([
      { createdAt: "asc" },
      { id: "asc" },
    ])
  })
})
