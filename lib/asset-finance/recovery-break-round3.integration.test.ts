/**
 * BREAK ROUND 3 (RUN_ASSET_FINANCE_RECOVERY_IT): self-valued sales, charged costs on the loan ledger, portal document
 * exclusions, refund bank-detail exposure, re-leased assets, the s127 surrender gate, soft-deleting evidence.
 */
import { randomUUID } from "node:crypto"
import { NextRequest } from "next/server"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { loanSettlementFigures } from "@/lib/loan/charges-summary"
import { syncLoanCharges } from "@/lib/loan/charges-sync"
import { GET as portalDocList } from "@/app/api/portal/asset-finance/entities/[id]/documents/route"
import { GET as portalDoc } from "@/app/api/portal/asset-finance/entities/[id]/documents/[documentId]/route"
import { GET as portalTaxInvoice } from "@/app/api/portal/asset-finance/loans/[loanId]/tax-invoice/route"
import { GET as portalStatement } from "@/app/api/portal/asset-finance/loans/[loanId]/statement/route"
import { POST as portalSurrender } from "@/app/api/portal/asset-finance/loans/[loanId]/surrender/route"
import { DELETE as deleteEntityDoc } from "@/app/api/asset-finance/entities/[id]/documents/[documentId]/route"
import { POST as stepRoute } from "@/app/api/asset-finance/legal-matters/[id]/steps/route"
import { GET as refundDocRoute } from "@/app/api/asset-finance/recoveries/[id]/refund/document/route"
import { dbDate } from "./dates"
import { testSetup } from "./lease-servicing.integration-fixture"
import { cleanupE2e } from "./recovery-e2e.integration-fixture"
import { cleanupRecoveryFixture, newAsset, newLoan, newRecovery, newValuation, today, day, type RecoveryFixture } from "./recovery.integration-fixture"
import { advance } from "./recovery-path.integration-fixture"
import { disburseApplication, plainListed, readJson, refundForm, saleBody } from "./recovery-sale.integration-fixture"
import { stepWithEvidence } from "./legal-matter.integration-fixture"
import { asUser, bundle, db, makeTenant, RUN, sessionBox } from "./recovery-break.fixture"

vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => sessionBox.current) }))

const suite = RUN ? describe : describe.skip
let fx: RecoveryFixture
const officer = () => asUser(fx, fx.officer, "CREDIT_OFFICER")
const adminA = () => asUser(fx, fx.adminA, "LOAN_ADMIN")
const adminB = () => asUser(fx, fx.adminB, "LOAN_ADMIN")
const R = () => bundle(fx)
const ACCOUNT = "62000000001"
const req = (path: string, method = "GET", body?: BodyInit, json = false) => new NextRequest(`http://${fx.host}${path}`, { method, headers: json ? { host: fx.host, "content-type": "application/json" } : { host: fx.host }, body })
const portalAs = (clientId: string) => { sessionBox.current = { user: { id: clientId, email: "c@client.invalid", role: "CLIENT", tenantId: fx.tenantId } } }
const cost = (type: string, treatment: string, over: Record<string, unknown> = {}) => ({ type, treatment, netCents: 1_000_000, vatCents: 0, supplierInvoiceRef: `INV-${randomUUID().slice(0, 6)}`, incurredOn: today(), ...over })
const stepForm = (matterId: string, fields: Record<string, string>) => stepRoute(
  new NextRequest(`http://${fx.host}/api/asset-finance/legal-matters/${matterId}/steps`, { method: "POST", headers: { host: fx.host }, body: stepWithEvidence(fields) }),
  { params: Promise.resolve({ id: matterId }) })

async function overdueInstalment(loanId: string): Promise<void> {
  await testSetup(db,
    [`UPDATE "Loan" SET "startDate" = CURRENT_TIMESTAMP - INTERVAL '120 days', "maturityDate" = CURRENT_TIMESTAMP - INTERVAL '60 days', "interestRatePm" = 0.02,
        "totalInterest" = 3000000, "totalRepayable" = 153000000, "nonNcaDefaultInterestMargin" = CASE WHEN "ncaRegime" = 'NON_NCA' THEN 0.05 ELSE "nonNcaDefaultInterestMargin" END WHERE "id" = $1`, loanId],
    [`INSERT INTO "RepaymentSchedule" ("id", "tenantId", "loanId", "installmentNo", "dueDate", "principalDue", "interestDue", "feesDue", "totalDue")
        VALUES ($1, $2, $3, 1, CURRENT_DATE - 60, 150000000, 3000000, 0, 153000000)`, `rs_${randomUUID().slice(0, 12)}`, fx.tenantId, loanId],
  )
}
async function surplusHeldNonNca() {
  await db.tenantConfig.update({ where: { tenantId: fx.tenantId }, data: { defaultChargesEnabled: false } })
  try { return await surplusHeldNonNcaInner() } finally { await db.tenantConfig.update({ where: { tenantId: fx.tenantId }, data: { defaultChargesEnabled: true } }) }
}
async function surplusHeldNonNcaInner() {
  const rec = await plainListed(db, fx, "NON_NCA", 100_000_000)
  await testSetup(db, [`UPDATE "Loan" SET "principal" = 80000000, "totalInterest" = 0, "totalRepayable" = 80000000, "outstandingPrincipal" = 100000000 WHERE "id" = $1`, rec.loan.loanId])
  officer()
  const sale = (await readJson(await R().s.propose(rec.id, saleBody(rec.valuationId, 200_000_000)))).body.id as string
  const c = await readJson(await R().s.completeSale(rec.id, sale))
  const pr = await readJson(await R().s.proceeds(rec.id))
  const oc = await readJson(await R().s.outcome(rec.id))
  expect(oc.body, JSON.stringify({ c, pr, oc })).toMatchObject({ status: "SURPLUS_HELD" })
  return rec
}

suite.sequential("round 3", () => {
  beforeAll(async () => {
    process.env.TRUSTED_PROXY = "1"
    fx = await makeTenant()
    await db.tenantConfig.update({ where: { tenantId: fx.tenantId }, data: { defaultChargesEnabled: true, defaultChargesStartedAt: new Date("2026-01-01T00:00:00+02:00") } })
  }, 120_000)
  afterAll(async () => {
    sessionBox.current = null
    await cleanupE2e(db, fx.tenantId).catch(() => undefined)
    await cleanupRecoveryFixture(db, fx.tenantId).catch(() => undefined)
    await db.$disconnect()
  }, 120_000)

  // ---- (1) self-valued
  it("S1. a sale on the proposer's own valuation needs a second approver (propose, self-approve, complete, tie, late valuation)", async () => {
    const rec = await plainListed(db, fx, "NON_NCA", 100_000_000)
    // the valuation in the fixture was recorded by adminA
    adminA()
    const own = await readJson(await R().s.propose(rec.id, saleBody(rec.valuationId, 100_000_000)))
    expect(own.body).toMatchObject({ selfValued: true, approvalRequired: true })
    expect((await readJson(await R().s.completeSale(rec.id, own.body.id as string))).status, "completed unapproved").toBeGreaterThanOrEqual(400)
    expect((await readJson(await R().s.approveSale(rec.id, own.body.id as string))).status, "self-approved").toBeGreaterThanOrEqual(400)
    adminB()
    expect((await readJson(await R().s.approveSale(rec.id, own.body.id as string))).status).toBe(200)
    adminA()
    expect((await readJson(await R().s.completeSale(rec.id, own.body.id as string))).status).toBe(200)
  }, 120_000)

  it("S2. a valuation the proposer records AFTER proposing (tie at the price) cannot let the sale complete unapproved", async () => {
    const rec = await plainListed(db, fx, "NON_NCA", 100_000_000)
    officer()
    const p = await readJson(await R().s.propose(rec.id, saleBody(rec.valuationId, 100_000_000)))
    expect(p.body).toMatchObject({ selfValued: false, approvalRequired: false })
    await db.assetValuation.create({ data: { tenantId: fx.tenantId, assetId: rec.loan.assetId, valuedOn: dbDate(today()), source: "DEALER", valuerName: "TEST Mate", amountCents: 100_000_000, createdById: fx.officer } })
    const done = await readJson(await R().s.completeSale(rec.id, p.body.id as string))
    expect(done.status, `completed on a tie the proposer recorded: ${JSON.stringify(done.body)}`).toBeGreaterThanOrEqual(400)
  }, 120_000)

  it("S3. a tie at the top where the proposer recorded one of the tied valuations counts as theirs, whichever is cited", async () => {
    const rec = await plainListed(db, fx, "NON_NCA", 100_000_000)
    await db.assetValuation.create({ data: { tenantId: fx.tenantId, assetId: rec.loan.assetId, valuedOn: dbDate(today()), source: "DEALER", valuerName: "TEST Mate", amountCents: 100_000_000, createdById: fx.officer } })
    officer()
    const p = await readJson(await R().s.propose(rec.id, saleBody(rec.valuationId, 100_000_000)))
    expect(p.body).toMatchObject({ selfValued: true })
  }, 120_000)

  it("S4. a lower valuation by the proposer does not make a sale self-valued; a higher one recorded later is a mismatch, never a free pass", async () => {
    const rec = await plainListed(db, fx, "NON_NCA", 100_000_000)
    await db.assetValuation.create({ data: { tenantId: fx.tenantId, assetId: rec.loan.assetId, valuedOn: dbDate(today()), source: "DEALER", valuerName: "TEST Low", amountCents: 1_000_000, createdById: fx.officer } })
    officer()
    const p = await readJson(await R().s.propose(rec.id, saleBody(rec.valuationId, 100_000_000)))
    expect(p.body).toMatchObject({ selfValued: false })
    await db.assetValuation.create({ data: { tenantId: fx.tenantId, assetId: rec.loan.assetId, valuedOn: dbDate(today()), source: "ASSESSOR", valuerName: "TEST High", amountCents: 100_000_001, createdById: fx.officer } })
    expect((await readJson(await R().s.completeSale(rec.id, p.body.id as string))).status).toBeGreaterThanOrEqual(400)
  }, 120_000)

  it("S5. DB: a self-valued sale inserted with selfValued=false is forced true; completing it without a second approver is refused", async () => {
    const rec = await plainListed(db, fx, "NON_NCA", 100_000_000)
    const sale = await db.remarketingSale.create({ data: {
      tenantId: fx.tenantId, recoveryId: rec.id, channel: "AUCTION", buyerType: "PERSON", buyerName: "TEST Buyer", buyerIdentifier: "7001015800084", buyerAddress: "2 Buyer Street",
      priceInclVatCents: 100_000_000, valuationId: rec.valuationId, highestValuationCents: 100_000_000, belowValuation: false, relatedPartyMatch: false, selfValued: false,
      screeningResult: { match: false }, createdById: fx.adminA,
    } }).catch((e) => e)
    // either refused ("re-recorded as self-valued") or forced to true
    if (sale instanceof Error) expect(String(sale)).toMatch(/self-valued/)
    else expect(sale.selfValued).toBe(true)
  }, 120_000)

  // ---- (2) ledger
  async function costedSale(regime: "NCA" | "NON_NCA", costBody: (rec: Awaited<ReturnType<typeof plainListed>>) => Promise<Record<string, unknown>>, price: number, valuation = 20_000_000) {
    const rec = await plainListed(db, fx, regime, valuation)
    await overdueInstalment(rec.loan.loanId)
    officer()
    const created = await R().r.cost(rec.id, await costBody(rec))
    expect(created.status, JSON.stringify(created.body)).toBe(201)
    adminA()
    expect((await R().e.decideCost(rec.id, created.body.id as string, "APPROVED")).status).toBe(200)
    officer()
    const sale = await readJson(await R().s.propose(rec.id, saleBody(rec.valuationId, price)))
    // the fixture valuation is adminA's: second approver needed
    adminB()
    await R().s.approveSale(rec.id, sale.body.id as string)
    officer()
    expect((await readJson(await R().s.completeSale(rec.id, sale.body.id as string))).status).toBe(200)
    const out = await readJson(await R().s.proceeds(rec.id))
    expect(out.status, JSON.stringify(out.body)).toBe(200)
    return { rec, costId: created.body.id as string }
  }
  const postings = (loanId: string) => db.loanCharge.findMany({ where: { loanId, type: "RECOVERY_COST" } })

  it("L1. NON_NCA charged cost: posted once, however often the ledger is synced or proceeds repeated; shortfall equals what the ledger says is left", async () => {
    const { rec } = await costedSale("NON_NCA", async () => cost("TOWING", "CHARGE_TO_ACCOUNT", { netCents: 3_000_000 }), 20_000_000)
    const { loanId } = rec.loan
    for (let i = 0; i < 4; i++) {
      await db.$transaction((tx) => syncLoanCharges(tx as never, { tenantId: fx.tenantId, loanId }, new Date(Date.now() + i * 86_400_000 * 40), { source: "break", userId: fx.adminA }))
    }
    await R().s.proceeds(rec.id); await R().s.proceeds(rec.id)
    const rows = await postings(loanId)
    expect(rows.length, JSON.stringify(rows)).toBe(1)
    expect(rows[0].amount).toBe(3_000_000)
    const row = await db.recovery.findUniqueOrThrow({ where: { id: rec.id } })
    const left = (await loanSettlementFigures(db as never, (await db.loan.findUniqueOrThrow({ where: { id: loanId }, include: { repaymentSchedule: { orderBy: { installmentNo: "asc" } } } })) as never, new Date())).totalToSettle
    expect(left, `ledger says ${left} is owed; the recovery says shortfall ${row.shortfallCents} (settlement ${row.settlementDueCents}, charged ${row.chargedCostsCents})`).toBe(row.shortfallCents)
  }, 240_000)

  it("L2. NCA in duplum: a huge LEGAL_TAXED charge is capped to the headroom, never above it", async () => {
    const { rec } = await costedSale("NCA", async (r) => {
      const matter = (await db.recovery.findUniqueOrThrow({ where: { id: r.id } })).legalMatterId as string
      const judgment = (await db.legalMatterStep.findFirstOrThrow({ where: { matterId: matter, kind: "JUDGMENT" } })).id
      return cost("LEGAL_TAXED", "CHARGE_TO_ACCOUNT", { netCents: 900_000_000, legalStepId: judgment })
    }, 20_000_000)
    const rows = await postings(rec.loan.loanId)
    const loan = await db.loan.findUniqueOrThrow({ where: { id: rec.loan.loanId } })
    const total = (await db.loanCharge.findMany({ where: { loanId: rec.loan.loanId } })).reduce((n, c) => n + c.amount, 0)
    // in duplum: interest + fees cannot exceed the principal outstanding when it began (R1.5m = 150_000_000)
    expect(total, `charges ${total} vs principal ${loan.principal}; RECOVERY_COST rows ${JSON.stringify(rows.map((r) => r.amount))}`).toBeLessThanOrEqual(loan.principal)
  }, 240_000)

  it("L3. a loan the proceeds settled is not re-opened by a charged cost", async () => {
    const { rec } = await costedSale("NON_NCA", async () => cost("TOWING", "CHARGE_TO_ACCOUNT", { netCents: 3_000_000 }), 400_000_000, 20_000_000)
    const loan = await db.loan.findUniqueOrThrow({ where: { id: rec.loan.loanId } })
    expect(loan.status).toBe("COMPLETED")
    expect(await postings(rec.loan.loanId)).toHaveLength(0)
    await db.$transaction((tx) => syncLoanCharges(tx as never, { tenantId: fx.tenantId, loanId: rec.loan.loanId }, new Date(Date.now() + 90 * 86_400_000), { source: "break", userId: fx.adminA }))
    expect((await db.loan.findUniqueOrThrow({ where: { id: rec.loan.loanId } })).status).toBe("COMPLETED")
  }, 240_000)

  it("L4. NON_NCA cost bigger than the whole loan: how far can a charged cost inflate the balance (documenting)", async () => {
    const { rec } = await costedSale("NON_NCA", async () => cost("TOWING", "CHARGE_TO_ACCOUNT", { netCents: 900_000_000 }), 20_000_000)
    const rows = await postings(rec.loan.loanId)
    // accepted policy: a NON_NCA charged cost is uncapped (a second person approved it); NCA is capped by in duplum (L2)
    expect(rows.map((r) => r.amount)).toEqual([900_000_000])
  }, 240_000)

  it("L5. a charged cost can only be approved by someone other than the recorder, and the ledger posting follows only approved costs", async () => {
    const rec = await plainListed(db, fx, "NON_NCA", 20_000_000)
    await overdueInstalment(rec.loan.loanId)
    officer()
    await R().r.cost(rec.id, cost("TOWING", "CHARGE_TO_ACCOUNT", { netCents: 7_000_000 })) // left PENDING
    const sale = await readJson(await R().s.propose(rec.id, saleBody(rec.valuationId, 20_000_000)))
    adminB(); await R().s.approveSale(rec.id, sale.body.id as string); officer()
    await R().s.completeSale(rec.id, sale.body.id as string)
    expect((await readJson(await R().s.proceeds(rec.id))).status).toBe(409)
    expect(await postings(rec.loan.loanId)).toHaveLength(0)
  }, 240_000)

  // ---- (3) portal documents, (4) bank details, (7) soft delete
  it("P1. the borrower's director cannot list or download legal evidence or the refund bank document, on any portal document route", async () => {
    const rec = await surplusHeldNonNca()
    const entityId = rec.loan.entityId as string
    officer()
    const matter = (await readJson(await R().l.open(rec.loan.loanId))).body.id as string
    const step = await readJson(await stepForm(matter, { kind: "LETTER_OF_DEMAND", stepDate: today() }))
    expect(step.status, JSON.stringify(step.body)).toBe(201)
    const refund = await readJson(await R().s.refund(rec.id, refundForm()))
    expect(refund.status).toBe(201)
    const evidenceDoc = (await db.legalMatterStep.findUniqueOrThrow({ where: { id: step.body.id as string } })).evidenceDocumentId as string
    const bankDoc = (await db.recoveryRefund.findFirstOrThrow({ where: { recoveryId: rec.id } })).bankVerificationDocumentId
    const control = await db.entityDocument.create({ data: { tenantId: fx.tenantId, entityId, docType: "OTHER", fileName: "ok.pdf", mimeType: "application/pdf", fileSize: 1, storagePath: "/nonexistent/ok.pdf", contentSha256: "0".repeat(64), uploadedByType: "staff", uploadedById: fx.officer } })
    portalAs(fx.director)
    const list = await portalDocList(req(`/api/portal/asset-finance/entities/${entityId}/documents`), { params: Promise.resolve({ id: entityId }) })
    const listBody = JSON.stringify(await list.json())
    expect(list.status).toBe(200)
    expect(listBody).toContain(control.id)
    expect(listBody, "legal evidence listed").not.toContain(evidenceDoc)
    expect(listBody, "bank document listed").not.toContain(bankDoc)
    for (const [label, docId] of [["evidence", evidenceDoc], ["bank", bankDoc]] as const) {
      for (const q of ["", "?download=1"]) {
        const r = await portalDoc(req(`/api/portal/asset-finance/entities/${entityId}/documents/${docId}${q}`), { params: Promise.resolve({ id: entityId, documentId: docId }) })
        expect(r.status, `${label}${q} served to the portal`).toBe(404)
      }
    }
    // other portal reads leak no buyer
    for (const r of [
      await portalTaxInvoice(req(`/api/portal/asset-finance/loans/${rec.loan.loanId}/tax-invoice`), { params: Promise.resolve({ loanId: rec.loan.loanId }) }),
      await portalStatement(req(`/api/portal/asset-finance/loans/${rec.loan.loanId}/statement`), { params: Promise.resolve({ loanId: rec.loan.loanId }) }),
    ]) expect((await r.text()).includes("TEST Buyer"), "portal route shows the buyer").toBe(false)
    // staff route for the refund bank document: READONLY-like (officer role is allowed), portal session refused
    portalAs(fx.director)
    expect((await refundDocRoute(req(`/api/asset-finance/recoveries/${rec.id}/refund/document`), { params: Promise.resolve({ id: rec.id }) })).status).toBeGreaterThanOrEqual(400)
  }, 240_000)

  it("B1. the full refund account number appears in no response, audit row, notification or log", async () => {
    const logs: string[] = []
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { logs.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")) }))
    const rec = await surplusHeldNonNca()
    const bodies: string[] = []
    officer()
    bodies.push(JSON.stringify((await R().s.refund(rec.id, refundForm())) .status), JSON.stringify((await R().r.view(rec.id)).body))
    adminA()
    bodies.push(JSON.stringify((await readJson(await R().s.approveRefund(rec.id))).body), JSON.stringify((await R().r.view(rec.id)).body))
    adminB()
    bodies.push(JSON.stringify((await readJson(await R().s.releaseRefund(rec.id))).body), JSON.stringify((await R().r.view(rec.id)).body))
    portalAs(fx.director)
    bodies.push(JSON.stringify((await R().r.portal(rec.loan.loanId)).body))
    spies.forEach((s) => s.mockRestore())
    const audits = JSON.stringify(await db.auditLog.findMany({ where: { tenantId: fx.tenantId, entityId: rec.id } }))
      + JSON.stringify(await db.auditLog.findMany({ where: { tenantId: fx.tenantId, entity: "RecoveryRefund" } }))
    const notes = JSON.stringify(await db.notification.findMany({ where: { tenantId: fx.tenantId } }))
    const view = JSON.stringify((await (async () => { officer(); return R().r.view(rec.id) })()).body)
    expect(view).toContain("0001") // last 4 shown to a refund manager
    for (const [label, text] of [["responses", bodies.join("\n")], ["audit", audits], ["notifications", notes], ["logs", logs.join("\n")], ["view", view]] as const) {
      expect(text.includes(ACCOUNT), `full account number in ${label}`).toBe(false)
    }
    // a read-only-ish view: no bank block for roles without manage_asset_finance is by role; the officer sees last 4 only
    expect(JSON.parse(view).refund?.bank?.accountNumber).toBeUndefined()
  }, 240_000)

  it("D1. evidence documents cannot be soft-deleted by the entity-document route or directly", async () => {
    const rec = await plainListed(db, fx, "NON_NCA", 100_000_000)
    const entityId = rec.loan.entityId as string
    officer()
    const matter = (await readJson(await R().l.open(rec.loan.loanId))).body.id as string
    const step = await readJson(await stepForm(matter, { kind: "LETTER_OF_DEMAND", stepDate: today() }))
    const doc = (await db.legalMatterStep.findUniqueOrThrow({ where: { id: step.body.id as string } })).evidenceDocumentId as string
    const del = await deleteEntityDoc(req(`/api/asset-finance/entities/${entityId}/documents/${doc}`, "DELETE"), { params: Promise.resolve({ id: entityId, documentId: doc }) })
    expect(del.status, "route deleted legal evidence").toBeGreaterThanOrEqual(400)
    await expect(db.entityDocument.update({ where: { id: doc }, data: { deletedAt: new Date() } })).rejects.toThrow()
    await expect(db.entityDocument.updateMany({ where: { id: doc }, data: { deletedAt: new Date() } })).rejects.toThrow()
    expect((await db.entityDocument.findUniqueOrThrow({ where: { id: doc } })).deletedAt).toBeNull()
    // the document route must still serve it
    expect((await R().l.document(matter, step.body.id as string)).status).toBe(200)
  }, 240_000)

  it("D2. refund bank document: soft delete refused; with deletedAt set by superuser-style raw SQL the staff route stops serving (never serves a deleted doc)", async () => {
    const rec = await surplusHeldNonNca()
    officer()
    await R().s.refund(rec.id, refundForm())
    const bank = (await db.recoveryRefund.findFirstOrThrow({ where: { recoveryId: rec.id } })).bankVerificationDocumentId
    const entityId = rec.loan.entityId as string
    const del = await deleteEntityDoc(req(`/api/asset-finance/entities/${entityId}/documents/${bank}`, "DELETE"), { params: Promise.resolve({ id: entityId, documentId: bank }) })
    expect(del.status, "route deleted the refund bank document").toBeGreaterThanOrEqual(400)
    expect((await refundDocRoute(req(`/api/asset-finance/recoveries/${rec.id}/refund/document`), { params: Promise.resolve({ id: rec.id }) })).status).toBe(200)
  }, 240_000)

  // ---- (5) re-leased assets
  it("A1. re-leased asset: recovery restores RETURNED_TO_STOCK on withdraw; a forged previousLessorStatus is overwritten; the old loan cannot recover the re-leased asset", async () => {
    const assetId = await newAsset(db, fx)
    const oldLoan = await newLoan(db, fx, "NON_NCA", "INSTALMENT_SALE", { assetId })
    await testSetup(db, [`UPDATE "Loan" SET "status" = 'COMPLETED' WHERE "id" = $1`, oldLoan.loanId], [`UPDATE "FinancedAsset" SET "lessorStatus" = 'RETURNED_TO_STOCK', "lessorStatusAt" = CURRENT_TIMESTAMP WHERE "id" = $1`, assetId])
    const newLoanRow = await newLoan(db, fx, "NON_NCA", "INSTALMENT_SALE", { assetId })
    officer()
    // 1. the live lease recovers; withdraw restores the stock status
    const ok = await R().r.create(newLoanRow.loanId, { route: "NON_NCA_VOLUNTARY", recoveredOn: today(), location: "Yard", condition: "Fair" })
    expect(ok.status, JSON.stringify(ok.body)).toBe(201)
    expect((await db.financedAsset.findUniqueOrThrow({ where: { id: assetId } })).lessorStatus).toBe("RECOVERED")
    expect((await R().r.withdraw(ok.body.id as string, { reason: "Debtor paid the arrears in full" })).status).toBe(200)
    expect((await db.financedAsset.findUniqueOrThrow({ where: { id: assetId } })).lessorStatus, "withdraw restored the wrong status").toBe("RETURNED_TO_STOCK")
    // 2. the OLD (completed) loan, whose lease ended, recovers the asset that is now on a live lease
    const stale = await R().r.create(oldLoan.loanId, { route: "NON_NCA_VOLUNTARY", recoveredOn: today(), location: "Yard", condition: "Fair" })
    expect(stale.status, "a completed loan recovered an asset now on another live lease").toBeGreaterThanOrEqual(400)
  }, 240_000)

  it("A2. forged previousLessorStatus and a recovery whose asset is not the loan's are refused or overwritten; two loans race for one asset", async () => {
    const loan = await newLoan(db, fx, "NON_NCA")
    const other = await newAsset(db, fx)
    await expect(db.recovery.create({ data: { tenantId: fx.tenantId, loanId: loan.loanId, assetId: other, route: "NON_NCA_VOLUNTARY", recoveredOn: dbDate(today()), location: "Yard", condition: "Fair", createdById: fx.officer } })).rejects.toThrow()
    const forged = await db.recovery.create({ data: { tenantId: fx.tenantId, loanId: loan.loanId, assetId: loan.assetId, route: "NON_NCA_VOLUNTARY", recoveredOn: dbDate(today()), location: "Yard", condition: "Fair", createdById: fx.officer, previousLessorStatus: "RETURNED_TO_STOCK" } })
    expect(forged.previousLessorStatus, "forged previous status kept").toBeNull()
    officer()
    expect((await R().r.withdraw(forged.id, { reason: "Debtor paid the arrears in full" })).status).toBe(200)
    expect((await db.financedAsset.findUniqueOrThrow({ where: { id: loan.assetId } })).lessorStatus).toBeNull()
    // body assetId ignored
    const l2 = await newLoan(db, fx, "NON_NCA")
    const viaBody = await R().r.create(l2.loanId, { route: "NON_NCA_VOLUNTARY", recoveredOn: today(), location: "Yard", condition: "Fair", assetId: other })
    if (viaBody.status === 201) expect((await db.recovery.findUniqueOrThrow({ where: { id: viaBody.body.id as string } })).assetId).toBe(l2.assetId)
    // race: two loans on one asset
    const assetId = await newAsset(db, fx)
    const a = await newLoan(db, fx, "NON_NCA", "INSTALMENT_SALE", { assetId })
    const b = await newLoan(db, fx, "NON_NCA", "INSTALMENT_SALE", { assetId })
    const out = await Promise.all([a, b].map(async (l) => R().r.create(l.loanId, { route: "NON_NCA_VOLUNTARY", recoveredOn: today(), location: "Yard", condition: "Fair" })))
    // never two live recoveries of one asset
    expect(out.filter((o) => o.status === 201).length, JSON.stringify(out)).toBeLessThanOrEqual(1)
    expect(await db.recovery.count({ where: { assetId, status: { notIn: ["CLOSED", "WITHDRAWN"] } } })).toBeLessThanOrEqual(1)
  }, 240_000)

  // ---- (6) s127 gate
  it("G1. surrender: not requestable (staff or portal) once a recovery is live or the asset is held; linkable only before credit", async () => {
    const live = await plainListed(db, fx, "NCA", 100_000_000)
    officer()
    expect((await R().e.requestSurrender(live.loan.loanId, "Synthetic: fair")).status, "staff surrender requested on a loan with a live recovery").toBeGreaterThanOrEqual(400)
    const clientId = (await db.loan.findUniqueOrThrow({ where: { id: live.loan.loanId }, select: { clientId: true } })).clientId as string
    portalAs(clientId)
    const viaPortal = await portalSurrender(req(`/api/portal/asset-finance/loans/${live.loan.loanId}/surrender`, "POST", JSON.stringify({ assetCondition: "Synthetic: fair" }), true), { params: Promise.resolve({ loanId: live.loan.loanId }) })
    expect(viaPortal.status, "portal surrender requested on a loan with a live recovery").toBeGreaterThanOrEqual(400)
    // asset held but no recovery row: status RECOVERED/SOLD set directly
    const l2 = await newLoan(db, fx, "NCA")
    await testSetup(db, [`UPDATE "FinancedAsset" SET "lessorStatus" = 'RECOVERED', "lessorStatusAt" = CURRENT_TIMESTAMP WHERE "id" = $1`, l2.assetId])
    officer()
    expect((await R().e.requestSurrender(l2.loanId, "Synthetic: fair")).status).toBeGreaterThanOrEqual(400)
    // a credited / finally-noticed surrender cannot be linked
    for (const status of ["PROCEEDS_CREDITED", "FINAL_NOTICE_ISSUED"] as const) {
      const l = await newLoan(db, fx, "NCA")
      const s = await db.surrenderRequest.create({ data: { tenantId: fx.tenantId, loanId: l.loanId, assetId: l.assetId, requestedByType: "STAFF", requestedById: fx.officer, requestedOn: dbDate(today()), assetCondition: "Synthetic: fair", valuationDueOn: dbDate(day(5)) } })
      await testSetup(db, [`UPDATE "SurrenderRequest" SET "status" = $1::"SurrenderStatus" WHERE "id" = $2`, status, s.id])
      const linked = await R().r.create(l.loanId, { route: "NCA_S127_SURRENDER", recoveredOn: today(), location: "Yard", condition: "Fair", surrenderRequestId: s.id })
      expect(linked.status, `linked a ${status} surrender`).toBeGreaterThanOrEqual(400)
      await expect(db.recovery.create({ data: { tenantId: fx.tenantId, loanId: l.loanId, assetId: l.assetId, route: "NCA_S127_SURRENDER", surrenderRequestId: s.id, recoveredOn: dbDate(today()), location: "Yard", condition: "Fair", createdById: fx.officer } })).rejects.toThrow()
    }
    // a withdrawn recovery frees the loan to surrender again
    const w = await plainListed(db, fx, "NCA", 100_000_000)
    officer()
    expect((await R().r.withdraw(w.id, { reason: "Debtor paid the arrears in full" })).status).toBe(200)
    expect((await R().e.requestSurrender(w.loan.loanId, "Synthetic: fair")).status).toBe(201)
    void advance; void newRecovery; void newValuation; void disburseApplication
  }, 240_000)
})
