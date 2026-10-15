/**
 * Slice 4a recovery rules, part 3 (migration 20261015400000): the proceeds,
 * the final notice, the end states, and the write-once columns. A recovery is
 * committed at each status through the real guards; each attack is refused,
 * and goes through with that one statement or clause taken out, in a
 * rolled-back transaction. The sale proceeds are a real payment of the lesser
 * of the net proceeds and the settlement; the deducted and charged costs are
 * the recorded costs; the result is the shortfall or surplus against what is
 * owed; an NCA freeze ends 10 SA business days after the final notice, a
 * NON_NCA one after the lender's demand period. Legal rules are UNTESTED
 * against the law: these prove the rules as written.
 *
 *   RUN_ASSET_FINANCE_RECOVERY_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/asset-finance/recovery-rules-proceeds.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient, type RecoveryStatus } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { addSouthAfricanBusinessDays } from "@/lib/compliance/sa-business-days"
import { dbDate } from "./dates"
import { advance, costData, proceedsKey, type PathOptions } from "./recovery-path.integration-fixture"
import {
  cleanupRecoveryFixture, courtMatter, createRecoveryFixture, day, newLoan, newRecovery, newSurrender, recoveryFixtureTenantId, today, type RecoveryFixture, type RecoveryLoan,
} from "./recovery.integration-fixture"
import { attempt } from "./lease-servicing.integration-fixture"
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
const G = "guardRecovery"
let fx: RecoveryFixture
interface Rec { loan: RecoveryLoan; id: string }
const R = {} as Record<"nonSold" | "ncaSold" | "nonProc" | "nonProcS" | "nonProcZ" | "ncaProc" | "ncaProcS" | "ncaProcZ" | "ncaFni" | "ncaFniS" | "ncaFniZ" | "ncaShort" | "ncaSurp" | "ncaVni" | "s127" | "costs", Rec>
let s127Surrender = ""
const SHA = "c".repeat(64)

async function ladder(nca: boolean, to: RecoveryStatus, o: PathOptions = {}, s127 = false): Promise<Rec> {
  const loan = await newLoan(database(), fx, nca ? "NCA" : "NON_NCA")
  const surrenderId = s127 ? await newSurrender(database(), fx, loan) : undefined
  const route = !nca ? "NON_NCA_VOLUNTARY" : s127 ? "NCA_S127_SURRENDER" : "NCA_S131_ATTACHMENT"
  const extra = !nca ? {} : s127 ? { surrenderRequestId: surrenderId } : { legalMatterId: await courtMatter(database(), fx, loan) }
  const id = await newRecovery(database(), fx, loan, route, extra)
  if (s127) s127Surrender = surrenderId ?? ""
  await advance(database(), fx, loan, id, to, { ...o, surrenderId })
  return { loan, id }
}

/** The proceeds of a sale at R1.2m against a R1.5m settlement (shortfall R300k), a real payment of the lesser amount, unless `over` says otherwise. */
const proceeds = (
  rec: Rec, over: Record<string, unknown> = {}, paymentCents: number | null = 120_000_000, from = today(), until: string | null | undefined = undefined, payment_: Record<string, unknown> = {},
) => async (tx: Tx) => {
  const payment = paymentCents === null ? null : await tx.payment.create({
    data: { tenantId: fx.tenantId, loanId: rec.loan.loanId, amount: paymentCents, capturedBy: fx.officer, idempotencyKey: proceedsKey(rec.id), ...payment_ } as never,
  })
  const nonNca = rec.loan.regime === "NON_NCA"
  const frozenUntil = until === undefined ? (nonNca ? addDays(from, 10) : null) : until
  await tx.recovery.update({
    where: { id: rec.id },
    data: {
      status: "PROCEEDS_APPLIED", settlementDueCents: 150_000_000, grossProceedsCents: 120_000_000, deductedCostsCents: 0, chargedCostsCents: 0, netProceedsCents: 120_000_000,
      shortfallCents: 30_000_000, surplusCents: 0, proceedsPaymentId: payment?.id ?? null, chargesFrozenFrom: dbDate(from), chargesFrozenUntil: frozenUntil ? dbDate(frozenUntil) : null, ...over,
    } as never,
  })
}
const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)
const finalNotice = (rec: Rec, over: Record<string, unknown> = {}) => (tx: Tx) => tx.recovery.update({
  where: { id: rec.id },
  data: {
    status: "FINAL_NOTICE_ISSUED", finalNoticeIssuedOn: dbDate(today()), finalNoticePath: "/nonexistent/fn.pdf", finalNoticeSha256: SHA,
    chargesFrozenUntil: dbDate(addSouthAfricanBusinessDays(today(), 10)), ...over,
  } as never,
})
/** The loan settled in full, as the receipt does (applyManualReceipt completes a loan paid in full); test setup only. */
const settled = (rec: Rec) => async (tx: Tx) => {
  await triggersOff(tx)
  await tx.$executeRawUnsafe(`UPDATE "Loan" SET "status" = 'COMPLETED' WHERE "id" = '${rec.loan.loanId}'`)
  await triggersOn(tx)
}
const move = (rec: Rec, status: RecoveryStatus, over: Record<string, unknown> = {}) => (tx: Tx) => tx.recovery.update({ where: { id: rec.id }, data: { status, ...over } })

suite("slice 4a recovery database rules: proceeds, final notice, end states", () => {
  beforeAll(async () => {
    fx = await createRecoveryFixture(database(), t)
    R.nonSold = await ladder(false, "SOLD")
    R.ncaSold = await ladder(true, "SOLD")
    R.costs = await ladder(false, "PROCEEDS_APPLIED", { costs: [
      { type: "TOWING", treatment: "DEDUCT_FROM_PROCEEDS", grossCents: 1_000_000 }, { type: "LEGAL_CONTRACTUAL", treatment: "CHARGE_TO_ACCOUNT", grossCents: 2_000_000 },
    ] })
    R.nonProc = await ladder(false, "PROCEEDS_APPLIED")
    R.nonProcS = await ladder(false, "PROCEEDS_APPLIED", { settlementCents: 80_000_000 })
    R.nonProcZ = await ladder(false, "PROCEEDS_APPLIED", { settlementCents: 120_000_000 })
    R.ncaProc = await ladder(true, "PROCEEDS_APPLIED")
    R.ncaProcS = await ladder(true, "PROCEEDS_APPLIED", { settlementCents: 80_000_000 })
    R.ncaProcZ = await ladder(true, "PROCEEDS_APPLIED", { settlementCents: 120_000_000 })
    R.ncaFni = await ladder(true, "FINAL_NOTICE_ISSUED")
    R.ncaFniS = await ladder(true, "FINAL_NOTICE_ISSUED", { settlementCents: 80_000_000 })
    R.ncaFniZ = await ladder(true, "FINAL_NOTICE_ISSUED", { settlementCents: 120_000_000 })
    R.ncaShort = await ladder(true, "SHORTFALL_OPEN")
    R.ncaSurp = await ladder(true, "SURPLUS_HELD", { settlementCents: 80_000_000 })
    R.ncaVni = await ladder(true, "VALUATION_NOTICE_ISSUED")
    R.s127 = await ladder(true, "PROCEEDS_APPLIED", {}, true)
  }, 600_000)

  afterAll(async () => {
    await cleanupRecoveryFixture(database(), recoveryFixtureTenantId(t)).catch(() => undefined)
    await database().$disconnect()
  }, 120_000)

  it("records the proceeds of a sale with its costs: shortfall = settlement + charged costs - net proceeds", async () => {
    const row = await database().recovery.findUniqueOrThrow({ where: { id: R.costs.id } })
    expect(row).toMatchObject({
      status: "PROCEEDS_APPLIED", settlementDueCents: 150_000_000, grossProceedsCents: 120_000_000, deductedCostsCents: 1_000_000, chargedCostsCents: 2_000_000,
      netProceedsCents: 119_000_000, shortfallCents: 33_000_000, surplusCents: 0,
    })
    expect(row.proceedsPaymentId).not.toBeNull()
    expect(row.chargesFrozenUntil).not.toBeNull()
  })

  describe("SOLD to PROCEEDS_APPLIED", () => {
    it("carries the full figures and freezes charges from today, the day the proceeds are applied", async () => {
      const rule = raiseOff(G, "Proceeds are applied with the full figures and the date charges freeze from")
      const message = /full figures and the date charges freeze from/
      await refuses(rule, message, move(R.ncaSold, "PROCEEDS_APPLIED", { chargesFrozenFrom: dbDate(today()) }))
      await refuses(rule, message, proceeds(R.ncaSold, {}, 120_000_000, day(1)))
      await refuses(rule, message, proceeds(R.ncaSold, {}, 120_000_000, day(-1)))
      await admits(proceeds(R.ncaSold))
      await admits(proceeds(R.nonSold))
    })

    it("deducts and charges exactly the costs recorded on the recovery", async () => {
      const rule = clauseOff(G, `IF NEW."deductedCostsCents" <> costs.deducted OR NEW."chargedCostsCents" <> costs.charged THEN`, "IF false THEN")
      const message = new RegExp("The deducted and charged costs are the recovery's recorded costs")
      await refuses(rule, message, proceeds(R.nonSold, { deductedCostsCents: 1_000_000, netProceedsCents: 119_000_000, shortfallCents: 31_000_000 }, 119_000_000))
      await refuses(rule, message, proceeds(R.nonSold, { chargedCostsCents: 5_000_000, shortfallCents: 35_000_000 }))
    })

    it("credits the lesser of the net proceeds and the settlement, as a live receipt on this loan", async () => {
      const rule = raiseOff(G, "The proceeds receipt is the lesser of the net proceeds and the settlement, credited to this loan")
      const message = /lesser of the net proceeds and the settlement/
      await refuses(rule, message, proceeds(R.nonSold, {}, 119_000_000))
      await refuses(rule, message, proceeds(R.nonSold, {}, null))
      await refuses(rule, message, async (tx) => {
        const elsewhere = await tx.payment.create({ data: { tenantId: fx.tenantId, loanId: R.ncaSold.loan.loanId, amount: 120_000_000 } })
        await proceeds(R.nonSold, { proceedsPaymentId: elsewhere.id }, null)(tx)
      })
      await refuses(rule, message, async (tx) => {
        const reversed = await tx.payment.create({ data: { tenantId: fx.tenantId, loanId: R.nonSold.loan.loanId, amount: 120_000_000, reversed: true } })
        await proceeds(R.nonSold, { proceedsPaymentId: reversed.id }, null)(tx)
      })
      // the settlement is the lesser: a R800k settlement is credited R800k, not the R1.2m price
      await admits(proceeds(R.nonSold, { settlementDueCents: 80_000_000, shortfallCents: 0, surplusCents: 40_000_000 }, 80_000_000))
    })

    it("waits for every cost to be decided, and counts only the approved ones", async () => {
      const record = (status?: "APPROVED" | "REJECTED") => async (tx: Tx) => {
        const cost = await tx.recoveryCost.create({ data: costData(fx, R.nonSold.id, { type: "TOWING", treatment: "DEDUCT_FROM_PROCEEDS", grossCents: 1_000_000 }) as never })
        if (status) await tx.recoveryCost.update({ where: { id: cost.id }, data: { status, approvedById: fx.adminA, approvedAt: new Date() } })
      }
      await refuses(raiseOff(G, "Proceeds are applied once every cost is decided"), /once every cost is decided/, async (tx) => { await record()(tx); await proceeds(R.nonSold)(tx) })
      // a rejected cost is neither deducted nor charged; an approved one is
      await admits(async (tx) => { await record("REJECTED")(tx); await proceeds(R.nonSold)(tx) })
      await admits(async (tx) => {
        await record("APPROVED")(tx)
        await proceeds(R.nonSold, { deductedCostsCents: 1_000_000, netProceedsCents: 119_000_000, shortfallCents: 31_000_000 }, 119_000_000)(tx)
      })
      const countRejected = clauseOff(G, `AND c."status" = 'APPROVED';`, ";")
      expect(await attempt(database(), async (tx) => { await record("REJECTED")(tx); await proceeds(R.nonSold)(tx) }, countRejected)).toMatch(/recorded costs/)
    })

    it("takes as its gross proceeds the price of the completed sale", async () => {
      await refuses(raiseOff(G, "The gross proceeds are the completed sale's price"), /gross proceeds are the completed sale's price/,
        proceeds(R.nonSold, { grossProceedsCents: 119_000_000, netProceedsCents: 119_000_000, shortfallCents: 31_000_000 }, 119_000_000))
    })

    it("credits this recovery's own receipt (by its idempotency key), received on or after the day the sale completed", async () => {
      const message = /lesser of the net proceeds and the settlement/
      const key = clauseOff(G, `AND p."idempotencyKey" = 'asset-recovery:' || NEW."id" || ':proceeds'`)
      await refuses(key, message, proceeds(R.nonSold, {}, 120_000_000, today(), undefined, { idempotencyKey: "asset-recovery:another:proceeds" }))
      await refuses(key, message, proceeds(R.nonSold, {}, 120_000_000, today(), undefined, { idempotencyKey: null }))
      const received = clauseOff(G, `AND (p."receivedAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Johannesburg')::date >= sale_day`)
      await refuses(received, message, proceeds(R.nonSold, {}, 120_000_000, today(), undefined, { receivedAt: new Date(Date.now() - 3 * 86_400_000) }))
    })

    it("credits no receipt when nothing is owed", async () => {
      await refuses(raiseOff(G, "No receipt is credited when the net proceeds or the settlement is nil"), /No receipt is credited when the net proceeds or the settlement is nil/,
        proceeds(R.nonSold, { settlementDueCents: 0, shortfallCents: 0, surplusCents: 120_000_000 }, 120_000_000))
      await admits(proceeds(R.nonSold, { settlementDueCents: 0, shortfallCents: 0, surplusCents: 120_000_000 }, null))
    })

    it("freezes an NCA recovery's charges to the final notice's date, not before", async () => {
      await refuses(raiseOff(G, "An NCA freeze ends 10 business days after the final notice, set with it"), /NCA freeze ends 10 business days after the final notice/,
        proceeds(R.ncaSold, {}, 120_000_000, today(), day(10)))
    })

    it("freezes a NON_NCA recovery's charges for the lender's demand period from the proceeds", async () => {
      const rule = raiseOff(G, "A NON_NCA freeze runs the lender's demand period from the proceeds")
      await refuses(rule, /runs the lender's demand period from the proceeds/, proceeds(R.nonSold, {}, 120_000_000, today(), day(5)))
      await refuses(rule, /runs the lender's demand period from the proceeds/, proceeds(R.nonSold, {}, 120_000_000, today(), null))
      await admits(proceeds(R.nonSold, {}, 120_000_000, today(), day(10)))
      // the period is the lender's setting, not a constant
      await admits(async (tx) => {
        await tx.tenantConfig.update({ where: { tenantId: fx.tenantId }, data: { nonNcaDemandPeriodDays: 20 } })
        await proceeds(R.nonSold, {}, 120_000_000, today(), day(20))(tx)
      })
      await refuses(rule, /runs the lender's demand period/, async (tx) => {
        await tx.tenantConfig.update({ where: { tenantId: fx.tenantId }, data: { nonNcaDemandPeriodDays: 20 } })
        await proceeds(R.nonSold, {}, 120_000_000, today(), day(10))(tx)
      })
    })
  })

  describe("PROCEEDS_APPLIED to FINAL_NOTICE_ISSUED", () => {
    it("is dated today, the day it is issued", async () => {
      const rule = raiseOff(G, "The final notice is dated from the proceeds to today")
      const message = /final notice is dated from the proceeds to today/
      await refuses(rule, message, finalNotice(R.ncaProc, { finalNoticeIssuedOn: dbDate(day(1)), chargesFrozenUntil: dbDate(addSouthAfricanBusinessDays(day(1), 10)) }))
      await refuses(rule, message, finalNotice(R.ncaProc, { finalNoticeIssuedOn: dbDate(day(-1)), chargesFrozenUntil: dbDate(addSouthAfricanBusinessDays(day(-1), 10)) }))
      await admits(finalNotice(R.ncaProc))
    })

    it("freezes charges until 10 SA business days after the notice", async () => {
      const rule = raiseOff(G, "Charges stay frozen until 10 business days after the final notice")
      await refuses(rule, /frozen until 10 business days after the final notice/, finalNotice(R.ncaProc, { chargesFrozenUntil: dbDate(today()) }))
      await refuses(rule, /frozen until 10 business days after the final notice/, finalNotice(R.ncaProc, { chargesFrozenUntil: dbDate(addSouthAfricanBusinessDays(today(), 9)) }))
    })

    it("is stored with its digest (s131), or follows the surrender's own final notice (s127)", async () => {
      await refuses(raiseOff(G, "An s131 final notice is stored with its digest"), /s131 final notice is stored with its digest/, finalNotice(R.ncaProc, { finalNoticePath: null, finalNoticeSha256: null }))
      const s127Notice = finalNotice(R.s127, { finalNoticePath: null, finalNoticeSha256: null })
      await refuses(raiseOff(G, "An s127 recovery follows its surrender's final notice"), /follows its surrender's final notice/, s127Notice)
      await admits(async (tx) => {
        await triggersOff(tx) // the surrender's own steps have their suite
        await tx.$executeRawUnsafe(`UPDATE "SurrenderRequest" SET "status" = 'FINAL_NOTICE_ISSUED', "finalNoticePath" = '/x.pdf', "finalNoticeSha256" = '${SHA}' WHERE "id" = '${s127Surrender}'`)
        await triggersOn(tx)
        await s127Notice(tx)
      })
    })
  })

  describe("the end states", () => {
    it("opens a shortfall only for a positive shortfall", async () => {
      await refuses(raiseOff(G, "A shortfall is open for a positive shortfall with its freeze end set"), /shortfall is open for a positive shortfall/, move(R.ncaFniZ, "SHORTFALL_OPEN"))
      await admits(move(R.ncaFni, "SHORTFALL_OPEN"))
      await admits(move(R.nonProc, "SHORTFALL_OPEN"))
    })

    it("holds a surplus only for a positive surplus", async () => {
      await refuses(raiseOff(G, "A surplus is held for a positive surplus"), /surplus is held for a positive surplus/, async (tx) => { await settled(R.ncaFni)(tx); await move(R.ncaFni, "SURPLUS_HELD")(tx) })
      await admits(async (tx) => { await settled(R.ncaFniS)(tx); await move(R.ncaFniS, "SURPLUS_HELD")(tx) })
      await admits(async (tx) => { await settled(R.nonProcS)(tx); await move(R.nonProcS, "SURPLUS_HELD")(tx) })
    })

    it("holds a surplus only once the loan is settled (the receipt completes a loan paid in full)", async () => {
      await refuses(raiseOff(G, "A surplus is held only once the loan is settled"), /surplus is held only once the loan is settled/, move(R.ncaFniS, "SURPLUS_HELD"))
      await refuses(raiseOff(G, "A surplus is held only once the loan is settled"), /surplus is held only once the loan is settled/, move(R.nonProcS, "SURPLUS_HELD"))
    })

    it("closes straight from the proceeds only with nothing owed either way", async () => {
      const close = (rec: Rec) => move(rec, "CLOSED", { closedAt: new Date() })
      await refuses(raiseOff(G, "A recovery closes straight from its proceeds only with no shortfall and no surplus"), /closes straight from its proceeds/, close(R.ncaFni))
      await refuses(raiseOff(G, "A recovery closes straight from its proceeds only with no shortfall and no surplus"), /closes straight from its proceeds/, close(R.nonProcS))
      await admits(close(R.ncaFniZ))
      await admits(close(R.nonProcZ))
    })

    it("closes an open shortfall once the loan is settled or written off", async () => {
      const close = move(R.ncaShort, "CLOSED", { closedAt: new Date() })
      await refuses(raiseOff(G, "A shortfall closes when the loan is settled or written off"), /shortfall closes when the loan is settled or written off/, close)
      await admits(async (tx) => {
        await triggersOff(tx)
        await tx.$executeRawUnsafe(`UPDATE "Loan" SET "status" = 'COMPLETED' WHERE "id" = '${R.ncaShort.loan.loanId}'`)
        await triggersOn(tx)
        await close(tx)
      })
    })

    it("closes a held surplus once its refund is released", async () => {
      await refuses(raiseOff(G, "A surplus closes when its refund is released"), /surplus closes when its refund is released/, move(R.ncaSurp, "CLOSED", { closedAt: new Date() }))
    })
  })

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
