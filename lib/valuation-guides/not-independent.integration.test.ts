/**
 * Slice 5 part C (§2a item 14): a GUIDE valuation never satisfies the
 * independent-valuation rules. A lease purchase rests on an assessor's or a
 * dealer's valuation (purchaseValuationOk, unchanged: its source clause is
 * what refuses a GUIDE one), and a recovery sale on a current valuation that is
 * neither INTERNAL nor GUIDE (guardRemarketingSale, migration
 * 20261021090200): not the one the sale relies on, not the highest it is
 * measured against, not a tie that would make it self-valued. The TS mirrors
 * (checkPurchaseValuation, valuationFacts, loadSaleValuations) agree.
 *
 *   RUN_ASSET_FINANCE_VALUATION_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/valuation-guides/not-independent.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { loadSaleValuations } from "@/components/asset-finance/recovery/recovery-panel-data"
import { bestMarketValuation, checkPurchaseValuation } from "@/lib/asset-finance/lease-term-end"
import { attempt } from "@/lib/asset-finance/lease-servicing.integration-fixture"
import { valuationFacts } from "@/lib/asset-finance/recovery-sale"
import { advance, saleData } from "@/lib/asset-finance/recovery-path.integration-fixture"
import {
  cleanupRecoveryFixture, createRecoveryFixture, newLoan, newRecovery, recordFixtureCommercialCancellation, recoveryFixtureTenantId,
  type RecoveryFixture, type RecoveryLoan,
} from "@/lib/asset-finance/recovery.integration-fixture"
import { clauseOff, rules, takeOut, type Tx } from "@/lib/asset-finance/recovery-rules.integration-fixture"
import { cleanupGuides, guideValuationData, publishedGuide, today, type GuideRowSeed } from "./guide.integration-fixture"
import { loadRevaluation } from "./revaluation-store"

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
const PV = "purchaseValuationOk"
const SALE = "guardRemarketingSale"
/** The recovery fixture's assets are TEST EX-R 2025; its independent valuation is R1m (100_000_000). */
const ROWS: GuideRowSeed[] = [
  { make: "TEST", model: "EX-R", year: 2025, variant: "", tradeCents: 130_000_000, retailCents: 150_000_000 },
  { make: "TEST", model: "EX-R", year: 2025, variant: "Tie", tradeCents: 100_000_000, retailCents: 120_000_000 },
]
const NOT_INDEPENDENT = `NOT IN ('INTERNAL', 'GUIDE')`
let fx: RecoveryFixture
let guide: { id: string; rowIds: string[] }
let lease: RecoveryLoan
let listed: { loan: RecoveryLoan; id: string }
/** GUIDE valuations at the higher row's trade value: of the lease's asset, and of the listed recovery's asset. */
const v = { lease: "", sale: "" }

const guideValuation = (tx: Tx | PrismaClient, assetId: string, row: number, createdById: string) =>
  tx.assetValuation.create({ data: guideValuationData(fx.tenantId, assetId, guide.id, guide.rowIds[row], ROWS[row].tradeCents, createdById), select: { id: true } })
const saleIn = async (tx: Tx, over: Record<string, unknown> = {}) =>
  tx.remarketingSale.create({ data: { ...(await saleData(database(), fx, listed.loan, listed.id)), ...over } as never, select: { id: true, selfValued: true, highestValuationCents: true } })

/** The value `run` returns inside a transaction that is rolled back, with `rule` taken out first when given. */
async function rolledBack<T>(run: (tx: Tx) => Promise<T>, rule?: Parameters<typeof takeOut>[1]): Promise<T> {
  let out: T | undefined
  const result = await attempt(database(), async (tx) => {
    if (rule) await takeOut(tx, rule)
    out = await run(tx)
  })
  if (result !== "ok" || out === undefined) throw new Error(`expected the database to admit it, got: ${result}`)
  return out
}

suite("a GUIDE valuation is never an independent valuation", () => {
  beforeAll(async () => {
    process.env.TRUSTED_PROXY = "1"
    fx = await createRecoveryFixture(database(), t)
    guide = await publishedGuide(database(), fx.tenantId, fx.adminA, fx.adminB, { rows: ROWS })
    lease = await newLoan(database(), fx, "NON_NCA", "OPERATING_LEASE")
    const loan = await newLoan(database(), fx, "NON_NCA")
    listed = { loan, id: await newRecovery(database(), fx, loan, "NON_NCA_VOLUNTARY") }
    await advance(database(), fx, loan, listed.id, "LISTED")
    await recordFixtureCommercialCancellation(database(), fx, loan.loanId)
    v.lease = (await guideValuation(database(), lease.assetId, 0, fx.adminB)).id
    v.sale = (await guideValuation(database(), listed.loan.assetId, 0, fx.adminB)).id
  }, 300_000)

  afterAll(async () => {
    if (!db) return
    await cleanupGuides(db, fx?.tenantId ?? recoveryFixtureTenantId(t)).catch(() => undefined)
    await cleanupRecoveryFixture(db, fx?.tenantId ?? recoveryFixtureTenantId(t)).catch(() => undefined)
    await db.$disconnect()
  }, 120_000)

  describe("lease purchase", () => {
    const elect = (tx: Tx) => tx.leaseEndOfTerm.create({
      data: { tenantId: fx.tenantId, loanId: lease.loanId, origin: "EXPIRY", outcome: "PURCHASE", status: "ELECTED", electedById: fx.officer,
        purchasePriceExclVatCents: ROWS[0].tradeCents, purchaseValuationId: v.lease },
    })

    it("refuses a purchase elected on a GUIDE valuation: purchaseValuationOk's source clause is what refuses it", async () => {
      await refuses(clauseOff(PV, ` AND v."source" IN ('ASSESSOR', 'DEALER')`), /at least the asset's market value/, elect)
    })

    it("and the server's own check refuses it before the database does; the portal's price ignores it", async () => {
      const check = await checkPurchaseValuation(database() as never, { tenantId: fx.tenantId, assetId: lease.assetId, valuationId: v.lease, today: today(), electorUserId: fx.officer })
      expect(check).toEqual({ ok: false, reason: "valuation_source", error: "A purchase rests on an assessor's or a dealer's valuation" })
      expect(await bestMarketValuation(database() as never, fx.tenantId, lease.assetId, today())).toBeNull()
    })
  })

  describe("recovery sale", () => {
    it("refuses a sale that relies on a GUIDE valuation", async () => {
      await refuses(
        clauseOff(SALE, `AND v."source" ${NOT_INDEPENDENT} AND v."valuedOn" >= today - max_age) THEN`, `AND v."valuedOn" >= today - max_age) THEN`),
        /relies on an independent \(not internal\) valuation/,
        (tx) => saleIn(tx, { valuationId: v.sale }),
      )
    })

    it("never measures a sale against a GUIDE valuation above the independent ones", async () => {
      const highest = clauseOff(SALE, `WHERE v."tenantId" = NEW."tenantId" AND v."assetId" = rec."assetId" AND v."source" ${NOT_INDEPENDENT} AND v."valuedOn" >= today - max_age;`,
        `WHERE v."tenantId" = NEW."tenantId" AND v."assetId" = rec."assetId" AND v."source" <> 'INTERNAL' AND v."valuedOn" >= today - max_age;`)
      // At R1.4m, above both: highestValuationCents is the R1m independent valuation, not the R1.3m guide value.
      const sale = (tx: Tx) => saleIn(tx, { priceInclVatCents: 140_000_000, belowValuation: false })
      await admits(sale)
      expect(await attempt(database(), sale, highest)).toMatch(/highest valuation recorded is the highest current independent valuation/)
    })

    it("never makes a sale self-valued by its proposer's GUIDE valuation at the highest amount", async () => {
      const tie = clauseOff(SALE, `AND v."source" ${NOT_INDEPENDENT}\n      AND v."valuedOn" >= today - max_age AND v."amountCents" = highest`,
        `AND v."source" <> 'INTERNAL'\n      AND v."valuedOn" >= today - max_age AND v."amountCents" = highest`)
      const proposerTie = async (tx: Tx) => {
        await guideValuation(tx, listed.loan.assetId, 1, fx.officer) // R1m: the independent valuation's amount, recorded by the proposer
        return saleIn(tx)
      }
      expect((await rolledBack(proposerTie)).selfValued).toBe(false)
      expect((await rolledBack(proposerTie, tie)).selfValued).toBe(true)
    })

    it("and the server's own checks agree: valuationFacts refuses it, the sale form never offers it", async () => {
      await expect(database().$transaction((tx) => valuationFacts(tx as never, fx.tenantId, listed.loan.assetId, v.sale, today(), fx.officer)))
        .rejects.toThrow("A sale rests on an independent valuation (not internal, not a guide value)")
      const independent = await database().assetValuation.findFirstOrThrow({ where: { tenantId: fx.tenantId, assetId: listed.loan.assetId, source: "ASSESSOR" } })
      const facts = await database().$transaction((tx) => valuationFacts(tx as never, fx.tenantId, listed.loan.assetId, independent.id, today(), fx.officer))
      expect(facts.highestCents).toBe(100_000_000)
      const offered = await loadSaleValuations(fx.tenantId, listed.loan.assetId)
      expect(offered.map((o) => o.value)).toContain(independent.id)
      expect(offered.map((o) => o.value)).not.toContain(v.sale)
    })
  })

  describe("book revaluation", () => {
    it("values each live loan's asset on the variant of its last guide value, LTV for the instalment sale only", async () => {
      const rows = await loadRevaluation(fx.tenantId)
      const leaseRow = rows.find((r) => r.loanId === lease.loanId)
      const saleRow = rows.find((r) => r.loanId === listed.loan.loanId)
      expect(leaseRow?.match).toMatchObject({ kind: "matched", basis: "recorded_variant", row: { variant: "", tradeCents: 130_000_000 }, ltvBps: null, changeCents: 0 })
      expect(saleRow?.match).toMatchObject({ kind: "matched", basis: "recorded_variant", row: { variant: "", tradeCents: 130_000_000 }, ltvBps: 11_538, changeCents: 0 })
    })
  })
})
