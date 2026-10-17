/**
 * Slice 4a recovery rules the first review found untested: the lender's demand
 * period CHECK, the unique indexes the schema generates (one invoice, one
 * surrender and one proceeds receipt per sale or recovery), the text minimums
 * of a recovery, the creator and recorder CHECKs of the legal matter, and two
 * boundaries (the age of the valuation a sale relies on, nil net proceeds
 * against a positive settlement). As in the other rule suites each rule is
 * refused, and goes through with that one rule taken out (CHECKs and indexes
 * with triggers off where the attack would meet a trigger first).
 *
 *   RUN_ASSET_FINANCE_RECOVERY_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/asset-finance/recovery-gaps-constraints.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, it, vi } from "vitest"
import { dbDate } from "./dates"
import { costData, proceedsKey, saleData } from "./recovery-path.integration-fixture"
import {
  addStep, recordFixtureCommercialCancellation, cleanupRecoveryFixture, createRecoveryFixture, day, newLoan, newMatter, newRecovery, newSurrender, recoveryFixtureTenantId, saleInvoice, today,
  type RecoveryFixture, type RecoveryLoan,
} from "./recovery.integration-fixture"
import { clauseOff, raiseOff, rules, triggersOff, type Tx } from "./recovery-rules.integration-fixture"
import { ladderRecovery } from "./recovery-path.integration-fixture"

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
interface Rec { loan: RecoveryLoan; id: string }
const R = {} as Record<"text" | "listed" | "listed2" | "done" | "sold" | "s127" | "proc", Rec>
/** Loans with no recovery: what a second recovery of an already used surrender or receipt is attacked on (the attack is rolled back). */
const spare = {} as Record<"nca" | "non", RecoveryLoan>
let spareSurrender = ""
let matterId = ""
let stepId = ""
let doneInvoice = ""
let maxAgeDays = 30

const UNIQUE = /Unique constraint|duplicate key/
const config = (name: string) => ({ table: "TenantConfig", constraint: name })
const sale = async (tx: Tx, rec: Rec, over: Record<string, unknown> = {}) =>
  tx.remarketingSale.create({ data: { ...(await saleData(database(), fx, rec.loan, rec.id)), ...over } as never })
const valuedDaysAgo = (rec: Rec, days: number) => async (tx: Tx) => (await tx.assetValuation.create({
  data: { tenantId: fx.tenantId, assetId: rec.loan.assetId, valuedOn: dbDate(day(-days)), source: "ASSESSOR", valuerName: "TEST", amountCents: 100_000_000 },
})).id

suite("slice 4a recovery rules: gaps found in review", () => {
  beforeAll(async () => {
    fx = await createRecoveryFixture(database(), t)
    const plain = await newLoan(database(), fx, "NON_NCA")
    R.text = { loan: plain, id: await newRecovery(database(), fx, plain, "NON_NCA_VOLUNTARY") }
    R.listed = await ladderRecovery(database(), fx, false, "LISTED")
    await recordFixtureCommercialCancellation(database(), fx, R.listed.loan.loanId)
    R.listed2 = await ladderRecovery(database(), fx, false, "LISTED")
    await recordFixtureCommercialCancellation(database(), fx, R.listed2.loan.loanId)
    R.done = await ladderRecovery(database(), fx, false, "SOLD")
    R.sold = await ladderRecovery(database(), fx, false, "SOLD")
    R.s127 = await ladderRecovery(database(), fx, true, "VALUATION_NOTICE_ISSUED", {}, true)
    R.proc = await ladderRecovery(database(), fx, false, "PROCEEDS_APPLIED")
    doneInvoice = (await database().remarketingSale.findFirstOrThrow({ where: { recoveryId: R.done.id, status: "COMPLETED" } })).taxInvoiceId as string
    spare.nca = await newLoan(database(), fx, "NCA")
    spare.non = await newLoan(database(), fx, "NON_NCA")
    spareSurrender = await newSurrender(database(), fx, spare.nca)
    const loan = await newLoan(database(), fx, "NCA")
    matterId = await newMatter(database(), fx, loan.loanId)
    stepId = await addStep(database(), fx, matterId, "LETTER_OF_DEMAND")
    maxAgeDays = (await database().tenantConfig.findUnique({ where: { tenantId: fx.tenantId }, select: { leasePurchaseValuationMaxAgeDays: true } }))?.leasePurchaseValuationMaxAgeDays ?? 30
  }, 600_000)

  afterAll(async () => {
    await cleanupRecoveryFixture(database(), recoveryFixtureTenantId(t)).catch(() => undefined)
    await database().$disconnect()
  }, 120_000)

  describe("TenantConfig_recovery_settings: the NON_NCA demand period is 1 to 90 days", () => {
    const period = (days: number) => (tx: Tx) => tx.tenantConfig.update({ where: { tenantId: fx.tenantId }, data: { nonNcaDemandPeriodDays: days } })
    const rule = config("TenantConfig_recovery_settings")

    it("refuses 0 and 91", async () => {
      await refuses(rule, /TenantConfig_recovery_settings/, period(0))
      await refuses(rule, /TenantConfig_recovery_settings/, period(91))
    })

    it("admits 1 and 90", async () => {
      await admits(period(1))
      await admits(period(90))
    })
  })

  describe("the unique indexes the schema generates", () => {
    it("RemarketingSale_taxInvoiceId_key: one tax invoice is one sale's", async () => {
      await refuses({ index: "RemarketingSale_taxInvoiceId_key" }, UNIQUE, async (tx) => {
        const second = await sale(tx, R.listed)
        await tx.remarketingSale.update({ where: { id: second.id }, data: { status: "COMPLETED", completedAt: new Date(), taxInvoiceId: doneInvoice } })
      }, [{ index: "RemarketingSale_tenantId_taxInvoiceId_key" }])
      await admits(async (tx) => {
        const second = await sale(tx, R.listed)
        await tx.remarketingSale.update({ where: { id: second.id }, data: { status: "COMPLETED", completedAt: new Date(), taxInvoiceId: await saleInvoice(database(), fx, second.priceInclVatCents) } })
      })
    })

    it("Recovery_surrenderRequestId_key: one surrender is one recovery's", async () => {
      const surrenderId = (await database().recovery.findUniqueOrThrow({ where: { id: R.s127.id } })).surrenderRequestId as string
      const second = async (tx: Tx, surrender: string) => {
        await triggersOff(tx) // the recovery's own rules would name the other surrender; only the index is under test
        const loan = spare.nca
        await tx.recovery.create({
          data: {
            tenantId: fx.tenantId, loanId: loan.loanId, assetId: loan.assetId, route: "NCA_S127_SURRENDER", surrenderRequestId: surrender, recoveredOn: dbDate(today()),
            location: "TEST Yard", condition: "Synthetic: fair", createdById: fx.officer,
          },
        })
      }
      await refuses({ index: "Recovery_surrenderRequestId_key" }, UNIQUE, (tx) => second(tx, surrenderId), [{ index: "Recovery_tenantId_surrenderRequestId_key" }])
      await admits((tx) => second(tx, spareSurrender))
    })

    it("Recovery_proceedsPaymentId_key: one receipt is one recovery's proceeds", async () => {
      const first = await database().recovery.findUniqueOrThrow({ where: { id: R.proc.id } })
      const second = (receipt: string | null) => async (tx: Tx) => {
        await triggersOff(tx)
        const loan = spare.non
        await tx.recovery.create({
          data: {
            tenantId: fx.tenantId, loanId: loan.loanId, assetId: loan.assetId, route: "NON_NCA_VOLUNTARY", recoveredOn: dbDate(today()), location: "TEST Yard", condition: "Synthetic: fair",
            createdById: fx.officer, status: "PROCEEDS_APPLIED", settlementDueCents: first.settlementDueCents, grossProceedsCents: first.grossProceedsCents,
            deductedCostsCents: first.deductedCostsCents, chargedCostsCents: first.chargedCostsCents, netProceedsCents: first.netProceedsCents, shortfallCents: first.shortfallCents,
            surplusCents: first.surplusCents, chargesFrozenFrom: first.chargesFrozenFrom, chargesFrozenUntil: first.chargesFrozenUntil, proceedsPaymentId: receipt,
          },
        })
      }
      await refuses({ index: "Recovery_proceedsPaymentId_key" }, UNIQUE, second(first.proceedsPaymentId), [{ index: "Recovery_tenantId_proceedsPaymentId_key" }])
      await admits(second(null))
    })
  })

  describe("text and actor CHECKs", () => {
    const rule = { table: "Recovery", constraint: "Recovery_text" }
    const set = (data: Record<string, unknown>) => (tx: Tx) => tx.recovery.update({ where: { id: R.text.id }, data: data as never })
    const off = (data: Record<string, unknown>) => async (tx: Tx) => { await triggersOff(tx); await set(data)(tx) }

    it("Recovery_text: a location is at least 2 characters and a condition at least 3, after trimming", async () => {
      await refuses(rule, /Recovery_text/, off({ location: "A" }))
      await refuses(rule, /Recovery_text/, off({ location: " A  " }))
      await refuses(rule, /Recovery_text/, off({ condition: "AB" }))
      await refuses(rule, /Recovery_text/, off({ condition: " AB  " }))
      await admits(set({ location: "AB" }))
      await admits(set({ location: " AB " }))
      await admits(set({ condition: "ABC" }))
      await admits(set({ condition: " ABC " }))
    })

    it("LegalMatter_creator and LegalMatterStep_recorder: the actor is named, not blank", async () => {
      const creator = { table: "LegalMatter", constraint: "LegalMatter_creator" }
      const recorder = { table: "LegalMatterStep", constraint: "LegalMatterStep_recorder" }
      await refuses(creator, /LegalMatter_creator/, async (tx) => {
        await triggersOff(tx)
        await tx.legalMatter.update({ where: { id: matterId }, data: { createdById: " " } })
      }, [{ table: "LegalMatter", constraint: "LegalMatter_tenantId_createdById_fkey" }])
      await refuses(recorder, /LegalMatterStep_recorder/, async (tx) => {
        await triggersOff(tx)
        await tx.legalMatterStep.update({ where: { id: stepId }, data: { recordedById: " " } })
      }, [{ table: "LegalMatterStep", constraint: "LegalMatterStep_tenantId_recordedById_fkey" }])
    })
  })

  describe("the age of the valuation a sale relies on (the lender's leasePurchaseValuationMaxAgeDays)", () => {
    const message = /relies on an independent \(not internal\) valuation of this asset dated within \d+ days/
    const age = clauseOff("guardRemarketingSale", `AND v."valuedOn" >= today - max_age) THEN`, `) THEN`)

    it("a valuation exactly the maximum age old is current, one day older is not", async () => {
      await admits(async (tx) => { await sale(tx, R.listed, { valuationId: await valuedDaysAgo(R.listed, maxAgeDays)(tx) }) })
      await refuses(age, message, async (tx) => { await sale(tx, R.listed, { valuationId: await valuedDaysAgo(R.listed, maxAgeDays + 1)(tx) }) })
    })
  })

  describe("nil net proceeds against a positive settlement", () => {
    const nil = (payment: number | null) => async (tx: Tx) => {
      const price = 120_000_000
      const cost = await tx.recoveryCost.create({ data: costData(fx, R.sold.id, { type: "TOWING", treatment: "DEDUCT_FROM_PROCEEDS", grossCents: price }) as never })
      await tx.recoveryCost.update({ where: { id: cost.id }, data: { status: "APPROVED", approvedById: fx.adminA, approvedAt: new Date() } })
      const receipt = payment === null ? null : await tx.payment.create({
        data: { tenantId: fx.tenantId, loanId: R.sold.loan.loanId, amount: payment, capturedBy: fx.officer, idempotencyKey: proceedsKey(R.sold.id) },
      })
      await tx.recovery.update({
        where: { id: R.sold.id },
        data: {
          status: "PROCEEDS_APPLIED", settlementDueCents: 150_000_000, grossProceedsCents: price, deductedCostsCents: price, chargedCostsCents: 0, netProceedsCents: 0,
          shortfallCents: 150_000_000, surplusCents: 0, proceedsPaymentId: receipt?.id ?? null, chargesFrozenFrom: dbDate(today()),
          chargesFrozenUntil: dbDate(day(10)),
        },
      })
    }

    it("deducting the whole price leaves nothing to credit: the shortfall is the whole settlement and no receipt exists", async () => {
      await admits(nil(null))
      await refuses(raiseOff("guardRecovery", "No receipt is credited when the net proceeds or the settlement is nil"), /No receipt is credited when the net proceeds or the settlement is nil/, nil(1))
    })
  })
})
