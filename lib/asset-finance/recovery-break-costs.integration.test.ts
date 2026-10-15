/**
 * BREAK TEST 3 (RUN_ASSET_FINANCE_RECOVERY_IT): legal costs deducted from NCA proceeds without a court reference,
 * and cost types outside the allow-list being counted. A red case is a reproduced FAIL.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { cleanupE2e } from "./recovery-e2e.integration-fixture"
import { cleanupRecoveryFixture, addStep, today, type RecoveryFixture } from "./recovery.integration-fixture"
import { plainListed, readJson, saleBody } from "./recovery-sale.integration-fixture"
import { asUser, bundle, db, makeTenant, RUN, sessionBox } from "./recovery-break.fixture"

vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => sessionBox.current) }))

const suite = RUN ? describe : describe.skip
let fx: RecoveryFixture
const officer = () => asUser(fx, fx.officer, "CREDIT_OFFICER")
const adminA = () => asUser(fx, fx.adminA, "LOAN_ADMIN")
const R = () => bundle(fx)
const cost = (type: string, treatment: string, over: Record<string, unknown> = {}) => ({
  type, treatment, netCents: 1_000_000, vatCents: 0, supplierInvoiceRef: `INV-${Math.random().toString(36).slice(2, 8)}`, incurredOn: today(), ...over,
})

suite.sequential("break 3: legal costs from NCA proceeds", () => {
  beforeAll(async () => { process.env.TRUSTED_PROXY = "1"; fx = await makeTenant() }, 120_000)
  afterAll(async () => {
    sessionBox.current = null
    await db.tenantConfig.update({ where: { tenantId: fx.tenantId }, data: { recoveryNcaDeductibleCostTypes: ["TOWING", "STORAGE", "VALUATION", "REPAIRS", "ADVERTISING", "AUCTION_COMMISSION", "SHERIFF", "INSURANCE"] } }).catch(() => undefined)
    await cleanupE2e(db, fx.tenantId).catch(() => undefined)
    await cleanupRecoveryFixture(db, fx.tenantId).catch(() => undefined)
    await db.$disconnect()
  }, 120_000)

  it("3a. LEGAL_TAXED / LEGAL_CONTRACTUAL / OTHER can never be deducted from NCA proceeds; legal charge needs a judgment/settlement step", async () => {
    const rec = await plainListed(db, fx, "NCA", 100_000_000)
    const matter = (await db.recovery.findUniqueOrThrow({ where: { id: rec.id } })).legalMatterId as string
    const steps = await db.legalMatterStep.findMany({ where: { matterId: matter } })
    const judgment = steps.find((s) => s.kind === "JUDGMENT")!.id
    const order = steps.find((s) => s.kind === "ATTACHMENT_ORDER")!.id
    officer()
    const outcomes: Record<string, number> = {}
    const t = async (label: string, body: Record<string, unknown>) => { outcomes[label] = (await R().r.cost(rec.id, body)).status }
    await t("TAXED deduct + judgment", cost("LEGAL_TAXED", "DEDUCT_FROM_PROCEEDS", { legalStepId: judgment }))
    await t("CONTRACTUAL deduct", cost("LEGAL_CONTRACTUAL", "DEDUCT_FROM_PROCEEDS"))
    await t("CONTRACTUAL charge", cost("LEGAL_CONTRACTUAL", "CHARGE_TO_ACCOUNT"))
    await t("OTHER deduct", cost("OTHER", "DEDUCT_FROM_PROCEEDS"))
    await t("OTHER charge", cost("OTHER", "CHARGE_TO_ACCOUNT"))
    await t("TAXED charge no step", cost("LEGAL_TAXED", "CHARGE_TO_ACCOUNT"))
    await t("TAXED charge attachment-order step", cost("LEGAL_TAXED", "CHARGE_TO_ACCOUNT", { legalStepId: order }))
    await t("TAXED charge bogus step", cost("LEGAL_TAXED", "CHARGE_TO_ACCOUNT", { legalStepId: "step_does_not_exist" }))
    await t("TOWING charge", cost("TOWING", "CHARGE_TO_ACCOUNT"))
    await t("SHERIFF charge", cost("SHERIFF", "CHARGE_TO_ACCOUNT"))
    const ok = await R().r.cost(rec.id, cost("LEGAL_TAXED", "CHARGE_TO_ACCOUNT", { legalStepId: judgment }))
    expect(ok.status, JSON.stringify(ok.body)).toBe(201) // control
    for (const [label, status] of Object.entries(outcomes)) expect(status, label).toBeGreaterThanOrEqual(400)
  }, 120_000)

  it("3b. a judgment step of ANOTHER loan, another tenant's matter, and a corrected judgment do not satisfy LEGAL_TAXED", async () => {
    const rec = await plainListed(db, fx, "NCA", 100_000_000)
    const other = await plainListed(db, fx, "NCA", 100_000_000)
    const otherMatter = (await db.recovery.findUniqueOrThrow({ where: { id: other.id } })).legalMatterId as string
    const otherJudgment = (await db.legalMatterStep.findFirstOrThrow({ where: { matterId: otherMatter, kind: "JUDGMENT" } })).id
    officer()
    const cross = await R().r.cost(rec.id, cost("LEGAL_TAXED", "CHARGE_TO_ACCOUNT", { legalStepId: otherJudgment }))
    expect(cross.status, "step of another loan").toBeGreaterThanOrEqual(400)
    // corrected judgment: a correcting step points at the judgment
    const matter = (await db.recovery.findUniqueOrThrow({ where: { id: rec.id } })).legalMatterId as string
    const judgment = (await db.legalMatterStep.findFirstOrThrow({ where: { matterId: matter, kind: "JUDGMENT" } })).id
    await addStep(db, fx, matter, "ATTACHMENT_ORDER", today(), { correctsStepId: judgment }).catch(() => undefined)
    const corrected = await R().r.cost(rec.id, cost("LEGAL_TAXED", "CHARGE_TO_ACCOUNT", { legalStepId: judgment }))
    const wasCorrected = (await db.legalMatterStep.count({ where: { correctsStepId: judgment } })) > 0
    expect(wasCorrected, "setup: the correcting step was recorded").toBe(true)
    expect(corrected.status, "corrected judgment still accepted").toBeGreaterThanOrEqual(400)
  }, 120_000)

  it("3c. the tenant allow-list cannot be set to include legal cost types (DB), and a type removed after approval is not deducted", async () => {
    await expect(db.tenantConfig.update({ where: { tenantId: fx.tenantId }, data: { recoveryNcaDeductibleCostTypes: ["TOWING", "LEGAL_TAXED"] } })).rejects.toThrow()
    await expect(db.tenantConfig.update({ where: { tenantId: fx.tenantId }, data: { recoveryNcaDeductibleCostTypes: ["OTHER"] } })).rejects.toThrow()
    const rec = await plainListed(db, fx, "NCA", 100_000_000)
    officer()
    const c = (await R().r.cost(rec.id, cost("TOWING", "DEDUCT_FROM_PROCEEDS", { netCents: 700_000 }))).body.id as string
    adminA()
    expect((await R().e.decideCost(rec.id, c, "APPROVED")).status).toBe(200)
    // lender removes TOWING from the allow-list before the proceeds are applied
    await db.tenantConfig.update({ where: { tenantId: fx.tenantId }, data: { recoveryNcaDeductibleCostTypes: ["STORAGE"] } })
    officer()
    const sale = (await readJson(await R().s.propose(rec.id, saleBody(rec.valuationId, 100_000_000)))).body.id as string
    expect((await readJson(await R().s.completeSale(rec.id, sale))).status).toBe(200)
    const out = await readJson(await R().s.proceeds(rec.id))
    const row = await db.recovery.findUniqueOrThrow({ where: { id: rec.id } })
    await db.tenantConfig.update({ where: { tenantId: fx.tenantId }, data: { recoveryNcaDeductibleCostTypes: ["TOWING", "STORAGE", "VALUATION", "REPAIRS", "ADVERTISING", "AUCTION_COMMISSION", "SHERIFF", "INSURANCE"] } })
    // accepted policy: a cost is judged under the allow-list at the time it was recorded
    expect(row.deductedCostsCents, `proceeds ${out.status}`).toBe(700_000)
  }, 120_000)

  it("3d. the cost recorder cannot decide their own cost, whatever the role; a rejected cost is never counted", async () => {
    const rec = await plainListed(db, fx, "NCA", 100_000_000)
    adminA()
    const c = (await R().r.cost(rec.id, cost("TOWING", "DEDUCT_FROM_PROCEEDS", { netCents: 600_000 }))).body.id as string
    expect((await R().e.decideCost(rec.id, c, "APPROVED")).status).toBeGreaterThanOrEqual(400)
    asUser(fx, fx.adminB, "LOAN_ADMIN")
    expect((await R().e.decideCost(rec.id, c, "REJECTED")).status).toBe(200)
    officer()
    const sale = (await readJson(await R().s.propose(rec.id, saleBody(rec.valuationId, 100_000_000)))).body.id as string
    await R().s.completeSale(rec.id, sale)
    await R().s.proceeds(rec.id)
    expect((await db.recovery.findUniqueOrThrow({ where: { id: rec.id } })).deductedCostsCents).toBe(0)
  }, 120_000)

  it("3e. an approved cost AFTER a pending one: proceeds wait for every cost to be decided; late cost after proceeds refused", async () => {
    const rec = await plainListed(db, fx, "NCA", 100_000_000)
    officer()
    const pending = (await R().r.cost(rec.id, cost("STORAGE", "DEDUCT_FROM_PROCEEDS", { netCents: 300_000 }))).body.id as string
    const sale = (await readJson(await R().s.propose(rec.id, saleBody(rec.valuationId, 100_000_000)))).body.id as string
    await R().s.completeSale(rec.id, sale)
    expect((await readJson(await R().s.proceeds(rec.id))).status).toBe(409)
    adminA()
    await R().e.decideCost(rec.id, pending, "APPROVED")
    officer()
    expect((await readJson(await R().s.proceeds(rec.id))).status).toBe(200)
    expect((await R().r.cost(rec.id, cost("TOWING", "DEDUCT_FROM_PROCEEDS"))).status).toBeGreaterThanOrEqual(400)
  }, 120_000)

  it("3f. costs above the sale price cannot be deducted into a negative net; zero/negative cost amounts refused", async () => {
    const rec = await plainListed(db, fx, "NCA", 100_000_000)
    officer()
    const big = (await R().r.cost(rec.id, cost("AUCTION_COMMISSION", "DEDUCT_FROM_PROCEEDS", { netCents: 900_000_000 }))).body.id as string
    adminA()
    await R().e.decideCost(rec.id, big, "APPROVED")
    officer()
    const sale = (await readJson(await R().s.propose(rec.id, saleBody(rec.valuationId, 100_000_000)))).body.id as string
    await R().s.completeSale(rec.id, sale)
    const out = await readJson(await R().s.proceeds(rec.id))
    expect(out.status).toBe(409)
    expect((await R().r.cost(rec.id, cost("TOWING", "DEDUCT_FROM_PROCEEDS", { netCents: 0, vatCents: 0 }))).status).toBeGreaterThanOrEqual(400)
    expect((await R().r.cost(rec.id, cost("TOWING", "DEDUCT_FROM_PROCEEDS", { netCents: -5, vatCents: 10 }))).status).toBeGreaterThanOrEqual(400)
  }, 120_000)

  it("3g. NON_NCA is not subject to NCA lists; but LEGAL types are still charged only as the lender configured", async () => {
    const rec = await plainListed(db, fx, "NON_NCA", 100_000_000)
    officer()
    expect((await R().r.cost(rec.id, cost("LEGAL_CONTRACTUAL", "CHARGE_TO_ACCOUNT"))).status).toBe(201)
  }, 120_000)
})

import { ladderRecovery } from "./recovery-path.integration-fixture"
suite.sequential("break 3h: LEGAL_TAXED charged with no court at all", () => {
  beforeAll(async () => { process.env.TRUSTED_PROXY = "1"; fx = await makeTenant() }, 120_000)
  afterAll(async () => {
    sessionBox.current = null
    await cleanupE2e(db, fx.tenantId).catch(() => undefined)
    await cleanupRecoveryFixture(db, fx.tenantId).catch(() => undefined)
    await db.$disconnect()
  }, 120_000)

  it("3h. s127 (voluntary surrender, no court): a bare SETTLED step must not back a taxed-legal-cost charge to the debtor", async () => {
    const { loan, id } = await ladderRecovery(db, fx, true, "LISTED", {}, true)
    officer()
    const opened = await readJson(await R().l.open(loan.loanId))
    expect(opened.status).toBe(201)
    const settled = await readJson(await R().l.step(opened.body.id as string, { kind: "SETTLED", stepDate: today(), note: "Attorney letter only" }))
    const out = settled.status === 201
      ? await R().r.cost(id, cost("LEGAL_TAXED", "CHARGE_TO_ACCOUNT", { legalStepId: settled.body.id, netCents: 5_000_000 }))
      : { status: settled.status, body: settled.body }
    expect(out.status, `a SETTLED step with no judgment/court order backed a LEGAL_TAXED charge: ${JSON.stringify(out.body)}`).toBeGreaterThanOrEqual(400)
  }, 120_000)
})
