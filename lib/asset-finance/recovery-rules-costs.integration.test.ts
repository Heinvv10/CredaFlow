/**
 * Slice 4a recovery cost rules (migration 20261015400000), each proved as in
 * the lease suites: the attack is refused, and goes through with that one
 * statement, clause or CHECK taken out, inside a rolled-back transaction. A
 * cost is immutable; it is recorded before the proceeds are applied; an NCA
 * recovery deducts only the lender's allowed types and charges only taxed
 * legal costs, which name a judgment or settlement step of the loan's legal
 * matter; a NON_NCA recovery records the lender's allowed types either way.
 * What a lender may recover is UNTESTED against the law: these prove the rules
 * as written.
 *
 *   RUN_ASSET_FINANCE_RECOVERY_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/asset-finance/recovery-rules-costs.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient, type RecoveryCostTreatment, type RecoveryCostType } from "@prisma/client"
import { afterAll, beforeAll, describe, it, vi } from "vitest"
import { dbDate } from "./dates"
import { advance } from "./recovery-path.integration-fixture"
import {
  addStep, cleanupRecoveryFixture, createRecoveryFixture, day, newLoan, newMatter, newRecovery, recoveryFixtureTenantId, today, type RecoveryFixture, type RecoveryLoan,
} from "./recovery.integration-fixture"
import { clauseOff, PASS_DELETE, raiseOff, rules, type Tx } from "./recovery-rules.integration-fixture"

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
const G = "guardRecoveryCost"
let fx: RecoveryFixture
interface Rec { loan: RecoveryLoan; id: string }
/** nca/non: RECOVERED; sold: NON_NCA SOLD; proc: NON_NCA PROCEEDS_APPLIED; gone: NON_NCA WITHDRAWN. */
const R = {} as Record<"nca" | "non" | "sold" | "proc" | "gone", Rec>
/** Steps of the NCA recovery's matter, and a step of another loan's matter. */
const steps = {} as Record<"letter" | "judgment" | "settled" | "corrected" | "correction" | "foreign", string>
let existingCost = ""
let rejectedCost = ""
const decide = (tx: Pick<PrismaClient, "recoveryCost">, id: string, status: "APPROVED" | "REJECTED", by = fx.adminA, over: Record<string, unknown> = {}) =>
  tx.recoveryCost.update({ where: { id }, data: { status, approvedById: by, approvedAt: new Date(), ...over } })

const cost = (tx: Pick<PrismaClient, "recoveryCost">, rec: Rec, over: Record<string, unknown> = {}) => tx.recoveryCost.create({
  data: {
    tenantId: fx.tenantId, recoveryId: rec.id, type: "TOWING", netCents: 100_000, vatCents: 15_000, grossCents: 115_000, supplierInvoiceRef: "INV-1", incurredOn: dbDate(today()),
    treatment: "DEDUCT_FROM_PROCEEDS", recordedById: fx.officer, ...over,
  } as never,
})
const taxed = (tx: Tx, legalStepId: string | null, over: Record<string, unknown> = {}) =>
  cost(tx, R.nca, { type: "LEGAL_TAXED", treatment: "CHARGE_TO_ACCOUNT", legalStepId, ...over })

suite("slice 4a recovery cost database rules", () => {
  beforeAll(async () => {
    fx = await createRecoveryFixture(database(), t)
    const ncaLoan = await newLoan(database(), fx, "NCA")
    const matterId = await newMatter(database(), fx, ncaLoan.loanId)
    steps.letter = await addStep(database(), fx, matterId, "LETTER_OF_DEMAND")
    steps.judgment = await addStep(database(), fx, matterId, "JUDGMENT")
    steps.settled = await addStep(database(), fx, matterId, "SETTLED")
    steps.corrected = await addStep(database(), fx, matterId, "JUDGMENT")
    steps.correction = await addStep(database(), fx, matterId, "LETTER_OF_DEMAND", today(), { correctsStepId: steps.corrected })
    steps.foreign = await addStep(database(), fx, await newMatter(database(), fx, (await newLoan(database(), fx, "NON_NCA")).loanId), "JUDGMENT")
    await addStep(database(), fx, matterId, "ATTACHMENT_ORDER")
    R.nca = { loan: ncaLoan, id: await newRecovery(database(), fx, ncaLoan, "NCA_S131_ATTACHMENT", { legalMatterId: matterId }) }
    for (const name of ["non", "sold", "proc", "gone"] as const) {
      const loan = await newLoan(database(), fx, "NON_NCA")
      R[name] = { loan, id: await newRecovery(database(), fx, loan, "NON_NCA_VOLUNTARY") }
    }
    await advance(database(), fx, R.sold.loan, R.sold.id, "SOLD")
    await advance(database(), fx, R.proc.loan, R.proc.id, "PROCEEDS_APPLIED")
    await advance(database(), fx, R.gone.loan, R.gone.id, "WITHDRAWN")
    existingCost = (await decide(database(), (await cost(database(), R.non)).id, "APPROVED")).id
    rejectedCost = (await decide(database(), (await cost(database(), R.non)).id, "REJECTED")).id
  }, 300_000)

  afterAll(async () => {
    await cleanupRecoveryFixture(database(), recoveryFixtureTenantId(t)).catch(() => undefined)
    await database().$disconnect()
  }, 120_000)

  describe("the two-step flow", () => {
    it("is recorded PENDING and undecided", async () => {
      await refuses(raiseOff(G, "A cost is recorded PENDING, undecided"), /recorded PENDING, undecided/,
        (tx) => cost(tx, R.non, { status: "APPROVED", approvedById: fx.adminA, approvedAt: new Date() }))
      await admits((tx) => cost(tx, R.non))
    })

    it("is decided once, approved or rejected, by a second person", async () => {
      await admits(async (tx) => decide(tx, (await cost(tx, R.non)).id, "APPROVED"))
      await admits(async (tx) => decide(tx, (await cost(tx, R.non)).id, "REJECTED"))
      await refuses({ table: "RecoveryCost", constraint: "RecoveryCost_approver_differs" }, /RecoveryCost_approver_differs/, async (tx) => decide(tx, (await cost(tx, R.non)).id, "APPROVED", fx.officer))
      await refuses({ table: "RecoveryCost", constraint: "RecoveryCost_status_columns" }, /RecoveryCost_status_columns/,
        async (tx) => tx.recoveryCost.update({ where: { id: (await cost(tx, R.non)).id }, data: { status: "APPROVED" } }))
      await refuses({ table: "RecoveryCost", constraint: "RecoveryCost_status_columns" }, /RecoveryCost_status_columns/,
        async (tx) => tx.recoveryCost.update({ where: { id: (await cost(tx, R.non)).id }, data: { approvedById: fx.adminA, approvedAt: new Date() } }))
    })

    it("changes nothing but its status, approver and time when it is decided", async () => {
      await refuses(raiseOff(G, "A cost decision changes only its status, approver and time"), /decision changes only its status, approver and time/,
        async (tx) => decide(tx, (await cost(tx, R.non)).id, "APPROVED", fx.adminA, { grossCents: 1, netCents: 1, vatCents: 0 }))
      await refuses(raiseOff(G, "A cost decision changes only its status, approver and time"), /decision changes only its status, approver and time/,
        async (tx) => tx.recoveryCost.update({ where: { id: (await cost(tx, R.non)).id }, data: { note: "edited" } }))
    })

    it("is immutable once decided, and never deleted", async () => {
      const rule = raiseOff(G, "A decided recovery cost is immutable")
      await refuses(rule, /decided recovery cost is immutable/, (tx) => tx.recoveryCost.update({ where: { id: existingCost }, data: { note: "edited" } }),
        [raiseOff(G, "A cost decision changes only its status, approver and time")])
      await refuses(rule, /decided recovery cost is immutable/, (tx) => decide(tx, rejectedCost, "APPROVED"))
      await refuses(rule, /decided recovery cost is immutable/, (tx) => tx.recoveryCost.update({ where: { id: existingCost }, data: { status: "REJECTED" } }))
      await refuses(raiseOff(G, "A recovery cost is never deleted", PASS_DELETE), /cost is never deleted/, (tx) => tx.recoveryCost.delete({ where: { id: existingCost } }))
      await refuses(raiseOff(G, "A recovery cost is never deleted", PASS_DELETE), /cost is never deleted/, async (tx) => tx.recoveryCost.delete({ where: { id: (await cost(tx, R.non)).id } }))
    })
  })

  describe("when it is recorded", () => {
    it("is before the sale proceeds are applied (and not on a withdrawn recovery)", async () => {
      const rule = raiseOff(G, "Costs are recorded before the sale proceeds are applied")
      await refuses(rule, /before the sale proceeds are applied/, (tx) => cost(tx, R.proc))
      await refuses(rule, /before the sale proceeds are applied/, (tx) => cost(tx, R.gone))
      await admits((tx) => cost(tx, R.non))
      await admits((tx) => cost(tx, R.sold))
    })

    it("is not dated in the future", async () => {
      await refuses(raiseOff(G, "A cost is not dated in the future"), /cost is not dated in the future/, (tx) => cost(tx, R.non, { incurredOn: dbDate(day(1)) }))
    })

    it("names a legal step of this loan's own matter, when it names one", async () => {
      await refuses(raiseOff(G, "A cost's legal step belongs to this loan's legal matter"), /legal step belongs to this loan's legal matter/,
        (tx) => cost(tx, R.non, { legalStepId: steps.foreign }))
      await admits((tx) => cost(tx, R.nca, { legalStepId: steps.letter }))
    })
  })

  describe("an NCA recovery", () => {
    it("deducts from the proceeds only the types the lender allows", async () => {
      const rule = raiseOff(G, "An NCA recovery deducts only the lender's allowed cost types from the proceeds")
      const message = /deducts only the lender's allowed cost types/
      await refuses(rule, message, (tx) => cost(tx, R.nca, { type: "LEGAL_CONTRACTUAL" }))
      await refuses(rule, message, (tx) => cost(tx, R.nca, { type: "OTHER" }))
      await admits((tx) => cost(tx, R.nca, { type: "TOWING" }))
      await admits((tx) => cost(tx, R.nca, { type: "AUCTION_COMMISSION" }))
      const allow = (types: RecoveryCostType[]) => (tx: Tx) => tx.tenantConfig.update({ where: { tenantId: fx.tenantId }, data: { recoveryNcaDeductibleCostTypes: { set: types } } })
      await admits(async (tx) => { await allow(["STORAGE"])(tx); await cost(tx, R.nca, { type: "STORAGE" }) }) // the allow-list is the lender's setting
      await refuses(rule, message, async (tx) => { await allow(["STORAGE"])(tx); await cost(tx, R.nca, { type: "TOWING" }) })
      await refuses(rule, message, async (tx) => { await allow([])(tx); await cost(tx, R.nca, { type: "TOWING" }) })
    })

    it("can never be configured to deduct contractual or untaxed legal costs, or other costs (CHECK TenantConfig_recovery_nca_deductible)", async () => {
      const check = { table: "TenantConfig", constraint: "TenantConfig_recovery_nca_deductible" }
      for (const type of ["LEGAL_TAXED", "LEGAL_CONTRACTUAL", "OTHER"] as RecoveryCostType[]) {
        await refuses(check, /TenantConfig_recovery_nca_deductible/, (tx) =>
          tx.tenantConfig.update({ where: { tenantId: fx.tenantId }, data: { recoveryNcaDeductibleCostTypes: { set: ["TOWING", type] } } }))
      }
      await admits((tx) => tx.tenantConfig.update({ where: { tenantId: fx.tenantId }, data: { recoveryNcaDeductibleCostTypes: { set: ["TOWING", "SHERIFF"] } } }))
    })

    it("charges to the account only taxed legal costs", async () => {
      await refuses(raiseOff(G, "Only taxed legal costs are charged to an NCA account"), /Only taxed legal costs are charged to an NCA account/,
        (tx) => cost(tx, R.nca, { type: "TOWING", treatment: "CHARGE_TO_ACCOUNT" }))
      await refuses(raiseOff(G, "Only taxed legal costs are charged to an NCA account"), /Only taxed legal costs are charged to an NCA account/,
        (tx) => cost(tx, R.nca, { type: "LEGAL_CONTRACTUAL", treatment: "CHARGE_TO_ACCOUNT" }))
    })

    it("names, for taxed legal costs, the judgment or settlement step of the matter, one nobody has corrected", async () => {
      const rule = raiseOff(G, "Taxed legal costs name the judgment or settlement step of the legal matter")
      const message = /Taxed legal costs name the judgment or settlement step/
      await refuses(rule, message, (tx) => taxed(tx, null))
      await refuses(rule, message, (tx) => taxed(tx, steps.letter))
      await admits((tx) => taxed(tx, steps.judgment))
      await admits((tx) => taxed(tx, steps.settled))
      await refuses(clauseOff(G, `AND NOT EXISTS (SELECT 1 FROM "LegalMatterStep" c WHERE c."tenantId" = s."tenantId" AND c."correctsStepId" = s."id")) THEN`, ") THEN"), message,
        (tx) => taxed(tx, steps.corrected))
    })
  })

  describe("a NON_NCA recovery", () => {
    it("records the types the lender allows, deducted or charged", async () => {
      const rule = raiseOff(G, "A NON_NCA recovery records only the lender's allowed cost types")
      const message = /records only the lender's allowed cost types/
      const only = (types: RecoveryCostType[]) => (tx: Tx) => tx.tenantConfig.update({ where: { tenantId: fx.tenantId }, data: { recoveryNonNcaChargeableCostTypes: { set: types } } })
      await refuses(rule, message, async (tx) => { await only(["TOWING"])(tx); await cost(tx, R.non, { type: "STORAGE" }) })
      await refuses(rule, message, async (tx) => { await only([])(tx); await cost(tx, R.non, { type: "TOWING" }) })
      for (const treatment of ["DEDUCT_FROM_PROCEEDS", "CHARGE_TO_ACCOUNT"] as RecoveryCostTreatment[]) {
        await admits((tx) => cost(tx, R.non, { type: "LEGAL_CONTRACTUAL", treatment }))
      }
      await admits(async (tx) => { await only(["TOWING"])(tx); await cost(tx, R.non, { type: "TOWING" }) })
    })

    it("needs no legal step for taxed legal costs", async () => {
      await admits((tx) => cost(tx, R.non, { type: "LEGAL_TAXED", treatment: "CHARGE_TO_ACCOUNT" }))
    })
  })

  describe("the row's CHECK constraints", () => {
    it("makes gross = net + VAT, no amount negative, and a cost worth recording", async () => {
      const check = { table: "RecoveryCost", constraint: "RecoveryCost_amounts" }
      await refuses(check, /RecoveryCost_amounts/, (tx) => cost(tx, R.non, { grossCents: 116_000 }))
      await refuses(check, /RecoveryCost_amounts/, (tx) => cost(tx, R.non, { netCents: -1000, vatCents: 16_000 }))
      await refuses(check, /RecoveryCost_amounts/, (tx) => cost(tx, R.non, { netCents: 0, vatCents: 0, grossCents: 0 }))
    })

    it("carries the supplier's invoice reference", async () => {
      await refuses({ table: "RecoveryCost", constraint: "RecoveryCost_invoice_ref" }, /RecoveryCost_invoice_ref/, (tx) => cost(tx, R.non, { supplierInvoiceRef: " " }))
    })
  })
})
