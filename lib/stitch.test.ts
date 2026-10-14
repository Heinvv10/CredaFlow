import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const { tenantConfigFindUnique, tenantFindMany } = vi.hoisted(() => ({
  tenantConfigFindUnique: vi.fn(),
  tenantFindMany: vi.fn(),
}))
vi.mock("@/lib/prisma", () => ({
  prisma: { tenantConfig: { findUnique: tenantConfigFindUnique }, tenant: { findMany: tenantFindMany } },
}))

import { loadStitchAccount, loadStitchWebhookSecret } from "./stitch"

// The STITCH_* environment is one lender's Stitch account: it may serve only
// the one ACTIVE tenant of a single-tenant deployment.
describe("Stitch environment fallback", () => {
  beforeEach(() => {
    for (const [k, v] of Object.entries({
      STITCH_CLIENT_ID: "env-client", STITCH_CLIENT_SECRET: "env-secret", STITCH_WEBHOOK_SECRET: "env-whsec",
      STITCH_BENEFICIARY_NAME: "Synthetic Lender", STITCH_BANK_ID: "synthetic-bank",
      STITCH_ACCOUNT_NUMBER: "0000000000", STITCH_BRANCH_CODE: "000000",
    })) vi.stubEnv(k, v)
    tenantConfigFindUnique.mockReset().mockResolvedValue(null)
    // One ACTIVE lender (t1); t2 is PROVISIONING, so not in the ACTIVE list.
    tenantFindMany.mockReset().mockResolvedValue([{ id: "t1" }])
  })
  afterEach(() => vi.unstubAllEnvs())

  it("serves the one ACTIVE tenant", async () => {
    expect(await loadStitchWebhookSecret("t1")).toBe("env-whsec")
    expect((await loadStitchAccount("t1")).beneficiary.accountNumber).toBe("0000000000")
  })

  it("never serves another tenant, even while it is the only other one", async () => {
    expect(await loadStitchWebhookSecret("t2")).toBeNull()
    await expect(loadStitchAccount("t2")).rejects.toThrow(/not configured for this lender/)
  })
})
