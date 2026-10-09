import { beforeEach, describe, expect, it, vi } from "vitest"

const { tenantConfigFindUnique, emptyAggregate } = vi.hoisted(() => ({
  tenantConfigFindUnique: vi.fn(),
  emptyAggregate: async () => ({ _count: 0, _sum: { sumAssured: null, premiumAmount: null } }),
}))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    insurancePolicy: { aggregate: emptyAggregate, groupBy: async () => [], count: async () => 0 },
    insuranceClaim: { groupBy: async () => [] },
    complaint: { groupBy: async () => [] },
    complianceRecord: { findFirst: async () => null },
    user: { findUnique: async () => null },
    tenantConfig: { findUnique: (a: unknown) => tenantConfigFindUnique(a) },
  },
}))

import { getFscaReturnData } from "./fsca-return"

describe("getFscaReturnData FSP number", () => {
  beforeEach(() => tenantConfigFindUnique.mockReset())

  it("states the tenant's own configured FSP licence number", async () => {
    tenantConfigFindUnique.mockResolvedValue({ fscaNumber: "12345" })
    expect((await getFscaReturnData("t1", "2026-Q2")).fspNumber).toBe("12345")
    expect(tenantConfigFindUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { tenantId: "t1" } }))
  })

  // A regulator return never carries a default licence number.
  it.each([null, "", "FSP12345"])("refuses when the configured FSP number is %j", async (fscaNumber) => {
    tenantConfigFindUnique.mockResolvedValue({ fscaNumber })
    await expect(getFscaReturnData("t1", "2026-Q2")).rejects.toMatchObject({ name: "LenderIdentityError" })
  })
})
