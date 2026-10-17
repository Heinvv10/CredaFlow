import { describe, expect, it, vi } from "vitest"
import { legalWordingApproved } from "./legal-wording-approved"

const db = (row: unknown) => {
  const findUnique = vi.fn().mockResolvedValue(row)
  return { db: { tenantConfig: { findUnique } } as unknown as Parameters<typeof legalWordingApproved>[0], findUnique }
}

describe("legalWordingApproved", () => {
  it("is true only when the tenant's flag is true", async () => {
    for (const row of [{ assetFinanceLegalWordingApproved: false }, null, {}]) {
      expect(await legalWordingApproved(db(row).db, "t-1")).toBe(false)
    }
    const approved = db({ assetFinanceLegalWordingApproved: true })
    expect(await legalWordingApproved(approved.db, "t-1")).toBe(true)
    expect(approved.findUnique).toHaveBeenCalledWith({ where: { tenantId: "t-1" }, select: { assetFinanceLegalWordingApproved: true } })
  })
})
