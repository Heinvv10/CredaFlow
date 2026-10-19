/**
 * Real-Postgres proof that the dealer portal can be switched on only for a
 * demo lender (CHECK TenantConfig_dealer_portal_demo_only, until dealer 2FA
 * ships), that clearing isDemoLender while it is on is refused, and that the
 * clawback window is 0..60 months (TenantConfig_dealer_clawback_months_range).
 * Migration 20261019120100_dealer_portal.
 *
 *   RUN_ASSET_FINANCE_DEALER_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/dealer/dealer-flag.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { expectRejected, sql } from "@/lib/asset-finance/af-sql.integration-fixture"
import { createDealFixture, cleanupDealFixture, dealFixtureTenantId } from "@/lib/asset-finance/deal.integration-fixture"
import { lit } from "./dealer.integration-fixture"

// The deal fixture imports the staff routes (next-auth); no route runs in this suite.
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => null) }))

const RUN = process.env.RUN_ASSET_FINANCE_DEALER_IT === "1"
const suite = RUN ? describe : describe.skip
const db = RUN ? new PrismaClient() : null
const t = randomUUID().replaceAll("-", "").slice(0, 16)
const tenantId = lit(dealFixtureTenantId(t))
const config = (set: string) => `UPDATE "TenantConfig" SET ${set} WHERE "tenantId" = ${tenantId}`
const read = (column: string) => sql(`SELECT "${column}" FROM "TenantConfig" WHERE "tenantId" = ${tenantId}`)

suite.sequential("dealer portal flag: demo lenders only (real DB)", () => {
  beforeAll(async () => {
    if (!db) throw new Error("RUN_ASSET_FINANCE_DEALER_IT=1 is required")
    await createDealFixture(db, t, { templates: false })
  }, 60_000)

  afterAll(async () => {
    if (!db) return
    await cleanupDealFixture(db, { tenantId: dealFixtureTenantId(t) })
    await db.$disconnect()
  })

  it("defaults to off with no clawback", () => {
    expect(read("featureDealerPortal")).toBe("f")
    expect(read("dealerCommissionClawbackMonths")).toBe("0")
  })

  it("refuses the flag on a lender that is not a demo lender", () => {
    expect(read("isDemoLender")).toBe("f")
    expectRejected(config(`"featureDealerPortal" = true`), "TenantConfig_dealer_portal_demo_only")
    expect(read("featureDealerPortal")).toBe("f")
  })

  it("allows it on a demo lender, then refuses clearing isDemoLender while it is on", () => {
    sql(config(`"isDemoLender" = true`))
    sql(config(`"featureDealerPortal" = true`))
    expect(read("featureDealerPortal")).toBe("t")
    expectRejected(config(`"isDemoLender" = false`), "TenantConfig_dealer_portal_demo_only")
    expect(read("isDemoLender")).toBe("t")
  })

  it("lets the demo marker go once the portal is off", () => {
    sql(config(`"featureDealerPortal" = false`))
    sql(config(`"isDemoLender" = false`))
    expect(read("isDemoLender")).toBe("f")
  })

  it("keeps the clawback window within 0..60 months", () => {
    sql(config(`"dealerCommissionClawbackMonths" = 60`))
    expectRejected(config(`"dealerCommissionClawbackMonths" = 61`), "TenantConfig_dealer_clawback_months_range")
    expectRejected(config(`"dealerCommissionClawbackMonths" = -1`), "TenantConfig_dealer_clawback_months_range")
    expect(read("dealerCommissionClawbackMonths")).toBe("60")
  })
})
