/**
 * A GUIDE valuation is never a statutory valuation while the legal question
 * is open (SLICE5.md Part C, deviation 6): the database refuses one as an s127
 * surrender's valuation (the figure on the s127 valuation notice) and as any
 * recovery's VALUED valuation (an s131 recovery's estimate). Migration
 * 20261021090200 patches guardSurrenderRequest and guardRecovery; each refusal
 * is shown to be what refuses, as in the slice 4 suites. (Review repros,
 * PR #229: legal and arch.)
 *
 *   RUN_ASSET_FINANCE_VALUATION_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/valuation-guides/guide-statutory.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, it, vi } from "vitest"
import { ladderRecovery } from "@/lib/asset-finance/recovery-path.integration-fixture"
import {
  cleanupRecoveryFixture, createRecoveryFixture, newLoan, newSurrender, recoveryFixtureTenantId, type RecoveryFixture,
} from "@/lib/asset-finance/recovery.integration-fixture"
import { raiseOff, rules, type Tx } from "@/lib/asset-finance/recovery-rules.integration-fixture"
import { dbDate } from "@/lib/asset-finance/dates"
import { cleanupGuides, guideValuationData, publishedGuide, today, type GuideRowSeed } from "./guide.integration-fixture"

vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => null) }))

const RUN = process.env.RUN_ASSET_FINANCE_VALUATION_IT === "1"
const suite = RUN ? describe : describe.skip
const db = RUN ? new PrismaClient() : null
const t = randomUUID().replaceAll("-", "").slice(0, 16)
const database = (): PrismaClient => {
  if (!db) throw new Error("RUN_ASSET_FINANCE_VALUATION_IT=1 is required")
  return db
}
const { refuses, admits } = rules(database)
const ROWS: GuideRowSeed[] = [{ make: "TEST", model: "EX-R", year: 2025, variant: "", tradeCents: 130_000_000, retailCents: 150_000_000 }]
const SURRENDER = "An s127 valuation is never a guide value: whether one may stand as the estimate is an open legal item"
const RECOVERY = "A recovery is never valued on a guide value: whether one may stand as the estimate is an open legal item"
let fx: RecoveryFixture
let guide: { id: string; rowIds: string[] }

const guideValuation = (tx: Tx, assetId: string) =>
  tx.assetValuation.create({ data: guideValuationData(fx.tenantId, assetId, guide.id, guide.rowIds[0], ROWS[0].tradeCents, fx.adminB), select: { id: true } })
const assessorValuation = (tx: Tx, assetId: string) =>
  tx.assetValuation.create({ data: { tenantId: fx.tenantId, assetId, valuedOn: dbDate(today()), source: "ASSESSOR", valuerName: "TEST Assessors", amountCents: 100_000_000, createdById: fx.adminB }, select: { id: true } })

suite("a GUIDE valuation is never a statutory valuation", () => {
  beforeAll(async () => {
    fx = await createRecoveryFixture(database(), t)
    guide = await publishedGuide(database(), fx.tenantId, fx.adminA, fx.adminB, { rows: ROWS })
  }, 300_000)

  afterAll(async () => {
    if (!db) return
    await cleanupGuides(db, fx?.tenantId ?? recoveryFixtureTenantId(t)).catch(() => undefined)
    await cleanupRecoveryFixture(db, fx?.tenantId ?? recoveryFixtureTenantId(t)).catch(() => undefined)
    await db.$disconnect()
  }, 120_000)

  it("refuses a GUIDE valuation as an s127 surrender's valuation, and admits an assessor's", async () => {
    const loan = await newLoan(database(), fx, "NCA")
    const surrenderId = await newSurrender(database(), fx, loan)
    const value = (valuation: (tx: Tx, assetId: string) => Promise<{ id: string }>) => async (tx: Tx) =>
      tx.surrenderRequest.update({ where: { id: surrenderId }, data: { status: "VALUED", valuationId: (await valuation(tx, loan.assetId)).id } })
    await admits(value(assessorValuation))
    await refuses(raiseOff("guardSurrenderRequest", SURRENDER), /never a guide value/, value(guideValuation))
  })

  it("refuses a GUIDE valuation as an NCA s131 recovery's VALUED valuation, and admits an assessor's", async () => {
    const { loan, id } = await ladderRecovery(database(), fx, true, "RECOVERED")
    const value = (valuation: (tx: Tx, assetId: string) => Promise<{ id: string }>) => async (tx: Tx) =>
      tx.recovery.update({ where: { id }, data: { status: "VALUED", valuationId: (await valuation(tx, loan.assetId)).id } })
    await admits(value(assessorValuation))
    await refuses(raiseOff("guardRecovery", RECOVERY), /never valued on a guide value/, value(guideValuation))
  })

  it("refuses one on a non-NCA recovery too: a guide value is a reference everywhere", async () => {
    const { loan, id } = await ladderRecovery(database(), fx, false, "RECOVERED")
    await refuses(raiseOff("guardRecovery", RECOVERY), /never valued on a guide value/, async (tx) =>
      tx.recovery.update({ where: { id }, data: { status: "VALUED", valuationId: (await guideValuation(tx, loan.assetId)).id } }))
  })
})
