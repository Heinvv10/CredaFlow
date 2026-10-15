/**
 * The two lease-era asset rules migration 20261015400000 restates, which had no
 * call of their own in the real-database suites (found by
 * recovery-migration-coverage.test.ts): an asset sold to the lessee stays so,
 * and a released asset cannot be put on a new deal. Each is refused, and goes
 * through with its RAISE taken out.
 *
 *   RUN_ASSET_FINANCE_RECOVERY_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/asset-finance/recovery-gaps-lessor.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, it, vi } from "vitest"
import { testSetup } from "./lease-servicing.integration-fixture"
import { cleanupRecoveryFixture, createRecoveryFixture, newAsset, newLoan, recoveryFixtureTenantId, type RecoveryFixture, type RecoveryLoan } from "./recovery.integration-fixture"
import { raiseOff, rules, triggersOff, triggersOn, type Tx } from "./recovery-rules.integration-fixture"

// The deal fixture imports the real route handlers, which import the session helper.
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => null) }))

const RUN = process.env.RUN_ASSET_FINANCE_RECOVERY_IT === "1"
const suite = RUN ? describe : describe.skip
const db = RUN ? new PrismaClient() : null
const t = randomUUID().replaceAll("-", "").slice(0, 16)
const database = (): PrismaClient => {
  if (!db) throw new Error("RUN_ASSET_FINANCE_RECOVERY_IT=1 is required")
  return db
}
const { refuses, admits } = rules(database)
let fx: RecoveryFixture
let loan: RecoveryLoan
let soldToLessee = ""

suite("lease-era asset rules restated by slice 4a", () => {
  beforeAll(async () => {
    fx = await createRecoveryFixture(database(), t)
    loan = await newLoan(database(), fx, "NON_NCA")
    soldToLessee = await newAsset(database(), fx)
    await testSetup(database(), [`UPDATE "FinancedAsset" SET "lessorStatus" = 'SOLD_TO_LESSEE' WHERE "id" = $1`, soldToLessee])
  }, 180_000)

  afterAll(async () => {
    await cleanupRecoveryFixture(database(), recoveryFixtureTenantId(t)).catch(() => undefined)
    await database().$disconnect()
  }, 60_000)

  it("an asset sold to the lessee is not the lessor's any more: its status does not change", async () => {
    const rule = raiseOff("guardAssetLessorStatus", "An asset sold to the lessee is not the lessor's any more")
    await refuses(rule, /sold to the lessee is not the lessor's any more/, (tx) => tx.financedAsset.update({ where: { id: soldToLessee }, data: { lessorStatus: "RETURNED_TO_STOCK" } }))
    await admits((tx) => tx.financedAsset.update({ where: { id: soldToLessee }, data: { cashPriceExclVatCents: 150_000_001 } }))
  })

  describe("a released asset cannot be financed again", () => {
    // Only the asset rule is under test: every other deal trigger is off for the insert, then the asset rule back on.
    const dealOn = (assetId: string) => async (tx: Tx) => {
      const row = await tx.loan.findUniqueOrThrow({ where: { id: loan.loanId }, select: { applicationId: true, entityId: true, clientId: true } })
      await tx.$executeRawUnsafe(`ALTER TABLE "AssetFinanceDeal" DISABLE TRIGGER USER`)
      await tx.$executeRawUnsafe(`ALTER TABLE "AssetFinanceDeal" ENABLE TRIGGER "AssetFinanceDeal_asset_unreleased"`)
      await tx.$executeRawUnsafe(
        `INSERT INTO "AssetFinanceDeal" ("id", "tenantId", "applicationId", "clientId", "entityId", "assetId", "supplierId", "weights", "structurePreset", "firstDueDate", "rateBasis", "createdById", "updatedAt")
         VALUES ($1, $2, $3, $4, $5, $6, $7, '[1]'::jsonb, 'MONTHLY', CURRENT_DATE, 'PRIME', $8, CURRENT_TIMESTAMP)`,
        `deal_rel_${randomUUID().replaceAll("-", "").slice(0, 12)}`, fx.tenantId, row.applicationId, row.clientId, row.entityId, assetId, fx.supplier, fx.officer,
      )
    }
    const released = (assetId: string) => async (tx: Tx) => {
      await triggersOff(tx)
      await tx.$executeRawUnsafe(`UPDATE "FinancedAsset" SET "releasedAt" = now() WHERE "id" = '${assetId}'`)
      await triggersOn(tx)
      await dealOn(assetId)(tx)
    }

    it("is refused for a released asset and admitted for an unreleased one", async () => {
      await refuses(raiseOff("guardAssetDealUnreleasedAsset", "The asset has been released and cannot be financed again"), /released and cannot be financed again/, released(loan.assetId))
      await admits(dealOn(loan.assetId))
    })
  })
})
