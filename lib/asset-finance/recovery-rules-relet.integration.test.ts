/**
 * Slice 4a re-leased assets and the s127 surrender state (migration
 * 20261015400000), each proved as in the lease suites. An asset a lease
 * returned to stock and a new lease took can be recovered: the recovery
 * remembers RETURNED_TO_STOCK, and withdrawing it gives that back (not none);
 * the asset's status reaches RECOVERED from none or RETURNED_TO_STOCK only
 * through an open recovery that remembers it, and leaves it only through that
 * recovery's withdrawal. An s127 recovery follows a surrender that is not yet
 * credited or finally noticed. The attack is refused (or the allowance
 * withdrawn), and goes through with that one statement or clause taken out,
 * inside a rolled-back transaction.
 *
 *   RUN_ASSET_FINANCE_RECOVERY_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/asset-finance/recovery-rules-relet.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient, type SurrenderStatus } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { dbDate } from "./dates"
import { attempt, testSetup } from "./lease-servicing.integration-fixture"
import { cleanupRecoveryFixture, createRecoveryFixture, newAsset, newLoan, newSurrender, recoveryFixtureTenantId, today, type RecoveryFixture, type RecoveryLoan } from "./recovery.integration-fixture"
import { clauseOff, raiseOff, rules, triggersOff, triggersOn, type Tx } from "./recovery-rules.integration-fixture"

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
/** The second lease of an asset the first lease returned to stock. */
let second: RecoveryLoan
const G = "guardRecovery"
const WITHDRAWN = { status: "WITHDRAWN" as const, withdrawnReason: "Debtor paid the arrears in full", closedAt: new Date() }

const open = (tx: Tx, loan: RecoveryLoan, over: Record<string, unknown> = {}) => tx.recovery.create({
  data: {
    tenantId: fx.tenantId, loanId: loan.loanId, assetId: loan.assetId, route: "NON_NCA_VOLUNTARY", recoveredOn: dbDate(today()), location: "TEST Yard", condition: "Synthetic: fair",
    createdById: fx.officer, ...over,
  },
})
const lessor = (tx: Tx, loan: RecoveryLoan) => tx.financedAsset.findUniqueOrThrow({ where: { id: loan.assetId }, select: { lessorStatus: true } }).then((a) => a.lessorStatus)

suite("slice 4a a re-leased asset is recovered, and an s127 recovery follows a live surrender", () => {
  beforeAll(async () => {
    fx = await createRecoveryFixture(database(), t)
    const assetId = await newAsset(database(), fx)
    const first = await newLoan(database(), fx, "NON_NCA", "OPERATING_LEASE", { assetId }) // the first lease, ended and returned
    await testSetup(database(), [`UPDATE "Loan" SET "status" = 'COMPLETED' WHERE "id" = $1`, first.loanId],
      [`UPDATE "FinancedAsset" SET "lessorStatus" = 'RETURNED_TO_STOCK', "lessorStatusAt" = CURRENT_TIMESTAMP WHERE "id" = $1`, assetId])
    second = await newLoan(database(), fx, "NON_NCA", "OPERATING_LEASE", { assetId })
  }, 300_000)

  afterAll(async () => {
    await cleanupRecoveryFixture(database(), recoveryFixtureTenantId(t)).catch(() => undefined)
    await database().$disconnect()
  }, 120_000)

  describe("an asset the first lease returned to stock", () => {
    it("is recovered on its second lease: the recovery remembers RETURNED_TO_STOCK, whatever the caller says", async () => {
      await admits(async (tx) => {
        const recovery = await open(tx, second, { previousLessorStatus: "SOLD_TO_LESSEE" })
        expect(recovery.previousLessorStatus).toBe("RETURNED_TO_STOCK")
        expect(await lessor(tx, second)).toBe("RECOVERED")
      })
      const sync = clauseOff("syncRecoveryAssetStatus", `("lessorStatus" IS NULL OR "lessorStatus" = 'RETURNED_TO_STOCK')`, `"lessorStatus" IS NULL`)
      expect(await attempt(database(), (tx) => open(tx, second), sync)).toMatch(/already recovered or sold/)
      const remembered = clauseOff(G, `SELECT a."lessorStatus" INTO NEW."previousLessorStatus" FROM "FinancedAsset" a WHERE a."id" = NEW."assetId" AND a."tenantId" = NEW."tenantId" FOR UPDATE;`, `NEW."previousLessorStatus" := NULL;`)
      expect(await attempt(database(), (tx) => open(tx, second), remembered)).toMatch(/already recovered or sold/) // it would not match the asset's status
    })

    it("gets RETURNED_TO_STOCK back when the recovery is withdrawn, not none", async () => {
      await admits(async (tx) => {
        const recovery = await open(tx, second)
        await tx.recovery.update({ where: { id: recovery.id }, data: WITHDRAWN })
        expect(await lessor(tx, second)).toBe("RETURNED_TO_STOCK")
      })
      const toNone = clauseOff("syncRecoveryAssetStatus", `SET "lessorStatus" = NEW."previousLessorStatus", "lessorStatusAt"`, `SET "lessorStatus" = NULL, "lessorStatusAt"`)
      expect(await attempt(database(), async (tx) => { const recovery = await open(tx, second); await tx.recovery.update({ where: { id: recovery.id }, data: WITHDRAWN }) }, toNone)).toMatch(/lessor status is not cleared/)
    })

    it("reaches RECOVERED only through an open recovery that remembers it", async () => {
      const recovered = (tx: Tx) => tx.financedAsset.update({ where: { id: second.assetId }, data: { lessorStatus: "RECOVERED" } })
      await refuses(raiseOff("guardAssetLessorStatus", "An asset is recovered by its open recovery"), /recovered by its open recovery/, recovered)
      // an open recovery that remembers a different status (none) does not count
      await refuses(clauseOff("guardAssetLessorStatus", `AND r."previousLessorStatus" IS NOT DISTINCT FROM OLD."lessorStatus"`), /recovered by its open recovery/, async (tx) => {
        await triggersOff(tx)
        await open(tx, second, { previousLessorStatus: null })
        await triggersOn(tx)
        await recovered(tx)
      })
    })

    it("leaves RECOVERED for RETURNED_TO_STOCK only through the withdrawal of a recovery that remembers it", async () => {
      const back = (tx: Tx) => tx.financedAsset.update({ where: { id: second.assetId }, data: { lessorStatus: "RETURNED_TO_STOCK" } })
      const message = /leaves the lender only through its recovery/
      await refuses(raiseOff("guardAssetLessorStatus", "A recovered asset leaves the lender only through its recovery"), message, async (tx) => { await open(tx, second); await back(tx) })
      await refuses(clauseOff("guardAssetLessorStatus", `AND r."previousLessorStatus" = 'RETURNED_TO_STOCK')`, `)`), message, async (tx) => {
        const recovery = await open(tx, second)
        await triggersOff(tx) // withdrawn without giving the asset back its status, and remembering none
        await tx.recovery.update({ where: { id: recovery.id }, data: { ...WITHDRAWN, previousLessorStatus: null } })
        await triggersOn(tx)
        await back(tx)
      })
    })

    it("cannot have the status it remembers changed", async () => {
      await refuses(clauseOff(G, `IF EXISTS (SELECT 1 FROM unnest(changed) AS k WHERE k <> ALL (allowed)) THEN`, "IF false THEN"), /write-once/, async (tx) => {
        const recovery = await open(tx, second)
        await tx.recovery.update({ where: { id: recovery.id }, data: { previousLessorStatus: null } })
      })
    })
  })

  describe("an s127 recovery follows its surrender", () => {
    const withSurrender = (status: SurrenderStatus) => async (tx: Tx) => {
      const loan = await newLoan(database(), fx, "NCA")
      const surrenderId = await newSurrender(database(), fx, loan)
      await triggersOff(tx)
      await tx.$executeRawUnsafe(`UPDATE "SurrenderRequest" SET "status" = '${status}'::"SurrenderStatus" WHERE "id" = '${surrenderId}'`)
      await triggersOn(tx)
      await open(tx, loan, { route: "NCA_S127_SURRENDER", surrenderRequestId: surrenderId })
    }
    const rule = raiseOff(G, "An s127 recovery follows a surrender that has not yet been credited or finally noticed")
    const message = /follows a surrender that has not yet been credited or finally noticed/

    it("while the surrender is REQUESTED, VALUED or has its valuation notice", async () => {
      for (const status of ["REQUESTED", "VALUED", "VALUATION_NOTICE_ISSUED"] as const) await admits(withSurrender(status))
    })

    it("and no longer once its proceeds are credited or its final notice issued", async () => {
      for (const status of ["PROCEEDS_CREDITED", "FINAL_NOTICE_ISSUED"] as const) await refuses(rule, message, withSurrender(status))
    })
  })
})
