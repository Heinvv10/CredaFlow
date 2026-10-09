import { describe, expect, it } from "vitest"
import { activeEligibilityRulesFindManyArgs, loadEligibilityRules } from "./rules"

const PARAMS = { tenantId: "tenant-1", productId: "product-1" }

describe("activeEligibilityRulesFindManyArgs", () => {
  it("scopes to the tenant and the product", () => {
    expect(activeEligibilityRulesFindManyArgs(PARAMS).where).toMatchObject({
      tenantId: "tenant-1",
      productId: "product-1",
    })
  })

  it("returns only active rules, so a deactivated term cannot satisfy a mandatory check", () => {
    expect(activeEligibilityRulesFindManyArgs(PARAMS).where.active).toBe(true)
  })

  it("selects the numeric value the evaluator screens against", () => {
    expect(activeEligibilityRulesFindManyArgs(PARAMS).select).toMatchObject({
      ruleType: true,
      lifeScope: true,
      numericValue: true,
      active: true,
    })
  })
})

describe("loadEligibilityRules", () => {
  it("passes the scoped query through and returns the rows unchanged", async () => {
    const calls: unknown[] = []
    const rows = [{ id: "r1", lifeScope: "ALL_LIVES", ruleType: "MAX_COVER", numericValue: "50000.00", textValue: null, active: true }]
    const prisma = {
      insuranceEligibilityRule: {
        findMany: async (args: unknown) => {
          calls.push(args)
          return rows
        },
      },
    } as never

    expect(await loadEligibilityRules(prisma, PARAMS)).toEqual(rows)
    expect(calls[0]).toMatchObject({ where: { tenantId: "tenant-1", productId: "product-1", active: true } })
  })
})
