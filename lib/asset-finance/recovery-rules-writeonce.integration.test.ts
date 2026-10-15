/**
 * Slice 4a recovery write-once columns (migration 20261015400000): a status
 * step writes only the columns of that step, so the figures, the proceeds
 * payment, the freeze dates, the notices and the valuation are fixed once
 * written. A recovery is committed at each status through the real guards;
 * each attack is refused, and goes through with that one clause of guardRecovery
 * taken out, in a rolled-back transaction.
 *
 *   RUN_ASSET_FINANCE_RECOVERY_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/asset-finance/recovery-rules-writeonce.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, it, vi } from "vitest"
import { dbDate } from "./dates"
import { ladderRecovery } from "./recovery-path.integration-fixture"
import { cleanupRecoveryFixture, createRecoveryFixture, day, recoveryFixtureTenantId, today, type RecoveryFixture, type RecoveryLoan } from "./recovery.integration-fixture"
import { clauseOff, raiseOff, rules, type Tx } from "./recovery-rules.integration-fixture"

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
const G = "guardRecovery"
let fx: RecoveryFixture
interface Rec { loan: RecoveryLoan; id: string }
const R = {} as Record<"nonProc" | "ncaFni" | "ncaVni" | "ncaSold", Rec>

suite("slice 4a recovery write-once columns", () => {
  beforeAll(async () => {
    fx = await createRecoveryFixture(database(), t)
    R.nonProc = await ladderRecovery(database(), fx, false, "PROCEEDS_APPLIED")
    R.ncaFni = await ladderRecovery(database(), fx, true, "FINAL_NOTICE_ISSUED")
    R.ncaVni = await ladderRecovery(database(), fx, true, "VALUATION_NOTICE_ISSUED")
    R.ncaSold = await ladderRecovery(database(), fx, true, "SOLD")
  }, 300_000)

  afterAll(async () => {
    await cleanupRecoveryFixture(database(), recoveryFixtureTenantId(t)).catch(() => undefined)
    await database().$disconnect()
  }, 120_000)

  describe("the write-once columns (a step writes only its own)", () => {
    const rule = clauseOff(G, `IF EXISTS (SELECT 1 FROM unnest(changed) AS k WHERE k <> ALL (allowed)) THEN`, "IF false THEN")
    const MESSAGE = /write-once/
    const update = (rec: Rec, data: Record<string, unknown>) => (tx: Tx) => tx.recovery.update({ where: { id: rec.id }, data: data as never })

    it("fixes the figures once written", async () => {
      await refuses(rule, MESSAGE, update(R.nonProc, { grossProceedsCents: 120_001_000, netProceedsCents: 120_001_000, shortfallCents: 29_999_000 }))
      await refuses(rule, MESSAGE, update(R.nonProc, { chargedCostsCents: 1, shortfallCents: 30_000_001 }))
    })

    it("fixes the payment and the freeze dates once written", async () => {
      await refuses(rule, MESSAGE, async (tx) => {
        const other = await tx.payment.create({ data: { tenantId: fx.tenantId, loanId: R.nonProc.loan.loanId, amount: 120_000_000 } })
        await update(R.nonProc, { proceedsPaymentId: other.id })(tx)
      })
      await refuses(rule, MESSAGE, update(R.nonProc, { chargesFrozenFrom: dbDate(day(-1)) }))
      await refuses(rule, MESSAGE, update(R.nonProc, { chargesFrozenUntil: dbDate(day(15)) }))
      await refuses(rule, MESSAGE, update(R.ncaFni, { chargesFrozenUntil: dbDate(day(30)) }))
    })

    it("fixes the final notice and the valuation notice once issued", async () => {
      await refuses(rule, MESSAGE, update(R.ncaFni, { finalNoticeIssuedOn: dbDate(day(-1)) }))
      await refuses(rule, MESSAGE, update(R.ncaFni, { finalNoticePath: "/nonexistent/other.pdf" }))
      await refuses(rule, MESSAGE, update(R.ncaVni, { valuationNoticePath: "/nonexistent/other.pdf" }))
    })

    it("fixes the valuation once the recovery is valued", async () => {
      await refuses(rule, MESSAGE, async (tx) => {
        const other = await tx.assetValuation.create({ data: { tenantId: fx.tenantId, assetId: R.ncaVni.loan.assetId, valuedOn: dbDate(today()), source: "ASSESSOR", valuerName: "TEST", amountCents: 1 } })
        await update(R.ncaVni, { valuationId: other.id })(tx)
      })
    })

    it("lets a step write only the columns of that step", async () => {
      await refuses(rule, MESSAGE, update(R.ncaSold, { status: "PROCEEDS_APPLIED", valuationId: null, chargesFrozenFrom: dbDate(today()) }), [
        raiseOff(G, "Proceeds are applied with the full figures and the date charges freeze from"),
      ])
      await admits(update(R.nonProc, { location: "TEST Other Yard", condition: "Synthetic: good" }))
    })
  })
})
