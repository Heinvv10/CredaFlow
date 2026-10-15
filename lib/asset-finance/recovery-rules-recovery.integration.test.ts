/**
 * Slice 4a recovery rules, part 1 (migration 20261015400000): how a recovery
 * opens and what it is tied to. Each rule is proved as in the lease suites:
 * the attack is refused, and goes through with that one statement, clause,
 * CHECK or index taken out, inside a rolled-back transaction. A recovery opens
 * RECOVERED on an asset-finance loan and its own asset; the route matches the
 * loan's NCA regime; s127 needs its own surrender, s131 an attachment order,
 * a NON_NCA court order a judgment; one open recovery per loan; the asset's
 * status follows the recovery in the database; the row's CHECKs. The status
 * matrix, figures and write-once columns are part 2
 * (recovery-rules-transitions.integration.test.ts). Legal rules are UNTESTED
 * against the law: these prove the rules as written.
 *
 *   RUN_ASSET_FINANCE_RECOVERY_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/asset-finance/recovery-rules-recovery.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient, type RecoveryRoute } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { dbDate } from "./dates"
import {
  cleanupRecoveryFixture, courtMatter, createRecoveryFixture, day, newAsset, newLoan, newMatter, newRecovery, newSurrender, recoveryFixtureTenantId,
  today, type RecoveryFixture, type RecoveryLoan,
} from "./recovery.integration-fixture"
import { testSetup } from "./lease-servicing.integration-fixture"
import { clauseOff, PASS_DELETE, raiseOff, rules, triggersOff, triggersOn, type Tx } from "./recovery-rules.integration-fixture"

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
type Name = "b" | "s" | "w" | "non1" | "non2" | "non3" | "nca1" | "nca2" | "plain"
const loans = {} as Record<Name, RecoveryLoan>
/** b: NON_NCA voluntary, RECOVERED; s: NCA s131, RECOVERED; w: NON_NCA, WITHDRAWN. */
const recoveries = {} as Record<"b" | "s" | "w", string>
const G = "guardRecovery"
const OPENS = "A recovery opens RECOVERED, with no valuation, notice, figures, payment, freeze or closure yet"

const insert = (tx: Tx, loan: RecoveryLoan, route: RecoveryRoute, extra: Record<string, unknown> = {}) => tx.recovery.create({
  data: {
    tenantId: fx.tenantId, loanId: loan.loanId, assetId: loan.assetId, route, recoveredOn: dbDate(today()), location: "TEST Yard", condition: "Synthetic: fair",
    createdById: fx.officer, ...extra,
  },
})
const matterOf = async (tx: Tx, loan: RecoveryLoan, ...kinds: string[]) => {
  const matter = await tx.legalMatter.create({ data: { tenantId: fx.tenantId, loanId: loan.loanId, createdById: fx.officer } })
  for (const kind of kinds) await tx.legalMatterStep.create({ data: { tenantId: fx.tenantId, matterId: matter.id, kind: kind as never, stepDate: dbDate(today()), recordedById: fx.officer } })
  return matter.id
}
const asset = (id: string) => database().financedAsset.findUniqueOrThrow({ where: { id }, select: { lessorStatus: true } }).then((a) => a.lessorStatus)

suite("slice 4a recovery database rules: opening a recovery", () => {
  beforeAll(async () => {
    fx = await createRecoveryFixture(database(), t)
    for (const name of ["b", "non1", "non2", "non3", "w"] as const) loans[name] = await newLoan(database(), fx, "NON_NCA")
    for (const name of ["s", "nca1", "nca2"] as const) loans[name] = await newLoan(database(), fx, "NCA")
    loans.plain = await newLoan(database(), fx, "NON_NCA", "LOAN")
    recoveries.b = await newRecovery(database(), fx, loans.b, "NON_NCA_VOLUNTARY")
    recoveries.s = await newRecovery(database(), fx, loans.s, "NCA_S131_ATTACHMENT", { legalMatterId: await courtMatter(database(), fx, loans.s) })
    recoveries.w = await newRecovery(database(), fx, loans.w, "NON_NCA_VOLUNTARY")
    await database().recovery.update({ where: { id: recoveries.w }, data: { status: "WITHDRAWN", withdrawnReason: "Debtor paid the arrears in full", closedAt: new Date() } })
  }, 180_000)

  afterAll(async () => {
    await cleanupRecoveryFixture(database(), recoveryFixtureTenantId(t)).catch(() => undefined)
    await database().$disconnect()
  }, 60_000)

  it("opens RECOVERED, with no later evidence", async () => {
    await refuses(raiseOff(G, OPENS), /opens RECOVERED/, (tx) => insert(tx, loans.non1, "NON_NCA_VOLUNTARY", { status: "VALUED" }))
    await refuses(raiseOff(G, OPENS), /opens RECOVERED/, (tx) => insert(tx, loans.non1, "NON_NCA_VOLUNTARY", { chargesFrozenFrom: dbDate(today()) }))
    await admits((tx) => insert(tx, loans.non1, "NON_NCA_VOLUNTARY"))
  })

  it("is not dated in the future", async () => {
    await refuses(raiseOff(G, "A recovery is not dated in the future"), /not dated in the future/, (tx) => insert(tx, loans.non1, "NON_NCA_VOLUNTARY", { recoveredOn: dbDate(day(1)) }))
  })

  it("belongs to an asset-finance loan and its own financed asset", async () => {
    const rule = raiseOff(G, "A recovery belongs to an asset-finance loan and its financed asset")
    await refuses(rule, /asset-finance loan and its financed asset/, (tx) => insert(tx, loans.plain, "NON_NCA_VOLUNTARY"))
    const other = await newAsset(database(), fx)
    await refuses(rule, /asset-finance loan and its financed asset/, (tx) => insert(tx, loans.non1, "NON_NCA_VOLUNTARY", { assetId: other }))
  })

  it("takes the route of the loan's NCA regime", async () => {
    const rule = raiseOff(G, "The recovery route must match the loan's NCA regime")
    await refuses(rule, /route must match the loan's NCA regime/, (tx) => insert(tx, loans.nca1, "NON_NCA_VOLUNTARY"))
    await refuses(rule, /route must match the loan's NCA regime/, async (tx) =>
      insert(tx, loans.non1, "NCA_S131_ATTACHMENT", { legalMatterId: await matterOf(tx, loans.non1, "JUDGMENT", "ATTACHMENT_ORDER") }))
  })

  describe("s127 surrender", () => {
    it("names a surrender, and only the s127 route does (CHECK Recovery_surrender_route)", async () => {
      const check = { table: "Recovery", constraint: "Recovery_surrender_route" }
      await refuses(check, /Recovery_surrender_route/, (tx) => insert(tx, loans.nca1, "NCA_S127_SURRENDER"))
      await refuses(check, /Recovery_surrender_route/, async (tx) => {
        const surrender = await tx.surrenderRequest.create({
          data: {
            tenantId: fx.tenantId, loanId: loans.nca1.loanId, assetId: loans.nca1.assetId, requestedByType: "STAFF", requestedById: fx.officer,
            requestedOn: dbDate(today()), assetCondition: "Synthetic: fair", valuationDueOn: dbDate(day(5)),
          },
        })
        await insert(tx, loans.nca1, "NCA_S131_ATTACHMENT", { surrenderRequestId: surrender.id, legalMatterId: await matterOf(tx, loans.nca1, "JUDGMENT", "ATTACHMENT_ORDER") })
      })
    })

    it("names the surrender of its own loan and asset", async () => {
      const foreign = await newSurrender(database(), fx, loans.nca2)
      await refuses(raiseOff(G, "An s127 recovery names the surrender of its own loan and asset"), /surrender of its own loan and asset/,
        (tx) => insert(tx, loans.nca1, "NCA_S127_SURRENDER", { surrenderRequestId: foreign }))
    })
  })

  describe("legal matter", () => {
    it("is the loan's own", async () => {
      const foreign = await newMatter(database(), fx, loans.non2.loanId)
      await refuses(raiseOff(G, "A recovery's legal matter is its own loan's"), /legal matter is its own loan's/, (tx) => insert(tx, loans.non1, "NON_NCA_VOLUNTARY", { legalMatterId: foreign }))
    })

    it("holds an attachment order for an s131 recovery", async () => {
      const rule = raiseOff(G, "An s131 recovery needs the legal matter's attachment order")
      await refuses(rule, /needs the legal matter's attachment order/, (tx) => insert(tx, loans.nca1, "NCA_S131_ATTACHMENT"))
      await refuses(rule, /needs the legal matter's attachment order/, async (tx) =>
        insert(tx, loans.nca1, "NCA_S131_ATTACHMENT", { legalMatterId: await matterOf(tx, loans.nca1, "LETTER_OF_DEMAND") }))
      await admits(async (tx) => insert(tx, loans.nca1, "NCA_S131_ATTACHMENT", { legalMatterId: await matterOf(tx, loans.nca1, "JUDGMENT", "ATTACHMENT_ORDER") }))
    })

    it("holds a judgment for a NON_NCA court-order recovery", async () => {
      const rule = raiseOff(G, "A NON_NCA court-order recovery needs the legal matter's judgment")
      await refuses(rule, /needs the legal matter's judgment/, (tx) => insert(tx, loans.non1, "NON_NCA_COURT_ORDER"))
      await refuses(rule, /needs the legal matter's judgment/, async (tx) =>
        insert(tx, loans.non1, "NON_NCA_COURT_ORDER", { legalMatterId: await matterOf(tx, loans.non1, "LETTER_OF_DEMAND") }))
      await admits(async (tx) => insert(tx, loans.non1, "NON_NCA_COURT_ORDER", { legalMatterId: await matterOf(tx, loans.non1, "JUDGMENT") }))
    })
  })

  describe("what a recovery stands on at the day it opens", () => {
    it("stands on an open legal matter", async () => {
      const rule = raiseOff(G, "A recovery stands on an open legal matter")
      const closed = async (tx: Tx) => {
        const matterId = await matterOf(tx, loans.nca1, "JUDGMENT", "ATTACHMENT_ORDER")
        await tx.legalMatter.update({ where: { id: matterId }, data: { status: "CLOSED", closedAt: new Date() } })
        return matterId
      }
      await refuses(rule, /stands on an open legal matter/, async (tx) => insert(tx, loans.nca1, "NCA_S131_ATTACHMENT", { legalMatterId: await closed(tx) }))
    })

    it("follows the attachment order or judgment: dated on or before the day it was recovered", async () => {
      const orderRule = clauseOff(G, `'ATTACHMENT_ORDER', NEW."recoveredOn")`, `'ATTACHMENT_ORDER')`)
      await refuses(orderRule, /needs the legal matter's attachment order/, async (tx) =>
        insert(tx, loans.nca1, "NCA_S131_ATTACHMENT", { recoveredOn: dbDate(day(-1)), legalMatterId: await matterOf(tx, loans.nca1, "JUDGMENT", "ATTACHMENT_ORDER") }))
      const judgmentRule = clauseOff(G, `'JUDGMENT', NEW."recoveredOn")`, `'JUDGMENT')`)
      await refuses(judgmentRule, /needs the legal matter's judgment/, async (tx) =>
        insert(tx, loans.non1, "NON_NCA_COURT_ORDER", { recoveredOn: dbDate(day(-1)), legalMatterId: await matterOf(tx, loans.non1, "JUDGMENT") }))
    })

    it("names a meter reading of its own asset, at opening and after", async () => {
      const rule = raiseOff(G, "A recovery's meter reading is its own asset's")
      const reading = async (tx: Tx, assetId: string) => (await tx.assetMeterReading.create({
        data: { tenantId: fx.tenantId, assetId, readingDate: dbDate(today()), value: 1200, unit: "HOURS", source: "STAFF" },
      })).id
      await refuses(rule, /meter reading is its own asset's/, async (tx) => insert(tx, loans.non1, "NON_NCA_VOLUNTARY", { meterReadingId: await reading(tx, loans.non2.assetId) }))
      await refuses(rule, /meter reading is its own asset's/, async (tx) =>
        tx.recovery.update({ where: { id: recoveries.b }, data: { meterReadingId: await reading(tx, loans.non2.assetId) } }))
      await admits(async (tx) => insert(tx, loans.non1, "NON_NCA_VOLUNTARY", { meterReadingId: await reading(tx, loans.non1.assetId) }))
    })
  })

  it("is one open recovery per loan: a second is refused until the first is closed or withdrawn", async () => {
    const second = async (tx: Tx) => {
      await triggersOff(tx) // the first recovery without its asset-status side effect, so only the index can refuse the second
      await insert(tx, loans.non1, "NON_NCA_VOLUNTARY")
      await triggersOn(tx)
      await insert(tx, loans.non1, "NON_NCA_VOLUNTARY", { location: "TEST Other Yard" })
    }
    await refuses({ index: "Recovery_one_open_per_loan" }, /Unique constraint|Recovery_one_open_per_loan/, second)
    await admits(async (tx) => {
      const first = await insert(tx, loans.non1, "NON_NCA_VOLUNTARY")
      await tx.recovery.update({ where: { id: first.id }, data: { status: "WITHDRAWN", withdrawnReason: "Debtor paid the arrears in full", closedAt: new Date() } })
      await insert(tx, loans.non1, "NON_NCA_VOLUNTARY")
    })
  })

  it("is fixed once opened: loan, asset, route, surrender, matter, date and creator", async () => {
    const rule = clauseOff(G, `IF EXISTS (SELECT 1 FROM unnest(changed) AS k WHERE k <> ALL (allowed)) THEN`, "IF false THEN")
    await refuses(rule, /write-once.*RECOVERED>RECOVERED may change only location, condition, meterReadingId/, (tx) => tx.recovery.update({ where: { id: recoveries.b }, data: { recoveredOn: dbDate(day(-1)) } }))
    await refuses(rule, /write-once/, (tx) => tx.recovery.update({ where: { id: recoveries.b }, data: { createdById: fx.adminA } }))
    await refuses(rule, /write-once/, (tx) => tx.recovery.update({ where: { id: recoveries.s }, data: { legalMatterId: null } }))
    await admits((tx) => tx.recovery.update({ where: { id: recoveries.b }, data: { location: "TEST Other Yard" } }))
  })

  it("is never deleted, and final once withdrawn", async () => {
    await refuses(raiseOff(G, "A recovery is never deleted", PASS_DELETE), /never deleted/, (tx) => tx.recovery.delete({ where: { id: recoveries.b } }))
    await refuses(raiseOff(G, "A closed or withdrawn recovery is final"), /closed or withdrawn recovery is final/,
      (tx) => tx.recovery.update({ where: { id: recoveries.w }, data: { location: "TEST Elsewhere" } }))
  })

  describe("the asset's status follows the recovery (the database writes it)", () => {
    it("is RECOVERED while a recovery is open and none again once it is withdrawn", async () => {
      expect(await asset(loans.b.assetId)).toBe("RECOVERED")
      expect(await asset(loans.s.assetId)).toBe("RECOVERED")
      expect(await asset(loans.w.assetId)).toBeNull()
    })

    it("is refused to a recovery of an asset already sold to the lessee (a returned asset may be recovered: see the re-lease suite)", async () => {
      await testSetup(database(), [`UPDATE "FinancedAsset" SET "lessorStatus" = 'SOLD_TO_LESSEE' WHERE "id" = $1`, loans.non3.assetId])
      await refuses(raiseOff("syncRecoveryAssetStatus", "The asset is already recovered or sold"), /already recovered or sold/,
        (tx) => insert(tx, loans.non3, "NON_NCA_VOLUNTARY"))
    })

    it("is RECOVERED only by an open recovery of that asset", async () => {
      await refuses(raiseOff("guardAssetLessorStatus", "An asset is recovered by its open recovery"), /recovered by its open recovery/,
        (tx) => tx.financedAsset.update({ where: { id: loans.non2.assetId }, data: { lessorStatus: "RECOVERED" } }))
      await refuses(raiseOff("guardAssetLessorStatus", "An asset is recovered by its open recovery"), /recovered by its open recovery/,
        (tx) => tx.financedAsset.update({ where: { id: loans.w.assetId }, data: { lessorStatus: "RECOVERED" } }))
    })

    it("leaves a recovered asset only through its recovery", async () => {
      await refuses(raiseOff("guardAssetLessorStatus", "A recovered asset leaves the lender only through its recovery"), /leaves the lender only through its recovery/,
        (tx) => tx.financedAsset.update({ where: { id: loans.b.assetId }, data: { lessorStatus: "RETURNED_TO_STOCK" } }))
      await refuses(raiseOff("guardAssetLessorStatus", "A leased asset's lessor status is not cleared"), /lessor status is not cleared/,
        (tx) => tx.financedAsset.update({ where: { id: loans.b.assetId }, data: { lessorStatus: null } }))
      await refuses(raiseOff("guardAssetLessorStatus", "A recovered asset is sold in remarketing by a completed sale"), /sold in remarketing by a completed sale/,
        (tx) => tx.financedAsset.update({ where: { id: loans.b.assetId }, data: { lessorStatus: "SOLD_IN_REMARKETING" } }))
    })

    it("is final once SOLD_IN_REMARKETING", async () => {
      await testSetup(database(), [`UPDATE "FinancedAsset" SET "lessorStatus" = 'SOLD_IN_REMARKETING' WHERE "id" = $1`, loans.non2.assetId])
      await refuses(raiseOff("guardAssetLessorStatus", "An asset sold in remarketing is not the lender's any more"), /sold in remarketing is not the lender's any more/,
        (tx) => tx.financedAsset.update({ where: { id: loans.non2.assetId }, data: { lessorStatus: "RETURNED_TO_STOCK" } }))
    })
  })

  describe("the row's CHECK constraints (triggers off, so only the constraint can refuse)", () => {
    const check = (name: string, id: () => string, data: () => Record<string, unknown>) =>
      refuses({ table: "Recovery", constraint: name }, new RegExp(name), async (tx) => {
        await triggersOff(tx)
        await tx.recovery.update({ where: { id: id() }, data: data() as never })
      })
    const SHA = "a".repeat(64)

    it("keeps s131 notices to s131 and NON_NCA ones free of any final notice date", async () => {
      await check("Recovery_s131_notices_only", () => recoveries.b, () => ({ valuationNoticePath: "/x.pdf", valuationNoticeSha256: SHA }))
      await check("Recovery_non_nca_no_final_notice_date", () => recoveries.b, () => ({ finalNoticeIssuedOn: dbDate(today()) }))
    })

    it("stores a notice's path with a 64-hex digest", async () => {
      await check("Recovery_notice_shape", () => recoveries.s, () => ({ valuationNoticePath: "/x.pdf" }))
      await check("Recovery_notice_shape", () => recoveries.s, () => ({ valuationNoticePath: "/x.pdf", valuationNoticeSha256: "not-a-digest" }))
    })

    it("writes the seven figures together, never negative, net = gross - deducted, and the result against what is owed", async () => {
      const figures = { settlementDueCents: 50, grossProceedsCents: 100, deductedCostsCents: 10, chargedCostsCents: 0, netProceedsCents: 90, shortfallCents: 0, surplusCents: 40 }
      await check("Recovery_figures_all_or_none", () => recoveries.b, () => ({ grossProceedsCents: 100 }))
      await check("Recovery_figures_nonnegative", () => recoveries.b, () => ({ ...figures, settlementDueCents: -5, deductedCostsCents: 0, netProceedsCents: 100, surplusCents: 105 }))
      await check("Recovery_net_proceeds", () => recoveries.b, () => ({ ...figures, netProceedsCents: 80, surplusCents: 30 }))
      await check("Recovery_shortfall_surplus", () => recoveries.b, () => ({ ...figures, shortfallCents: 5 }))
      await check("Recovery_shortfall_surplus", () => recoveries.b, () => ({ ...figures, surplusCents: 41 }))
    })

    it("freezes charges over a window that starts before it ends", async () => {
      await check("Recovery_freeze_window", () => recoveries.b, () => ({ chargesFrozenFrom: dbDate(today()), chargesFrozenUntil: dbDate(day(-1)) }))
      await check("Recovery_freeze_window", () => recoveries.b, () => ({ chargesFrozenUntil: dbDate(day(5)) }))
    })

    it("closes with a closing time and withdraws with a reason, nothing else does", async () => {
      await check("Recovery_closed_columns", () => recoveries.b, () => ({ status: "CLOSED" }))
      await check("Recovery_closed_columns", () => recoveries.b, () => ({ withdrawnReason: "Not a withdrawal at all" }))
    })

    it("names where the asset is and in what condition", async () => {
      await check("Recovery_text", () => recoveries.b, () => ({ location: " " }))
    })
  })
})
