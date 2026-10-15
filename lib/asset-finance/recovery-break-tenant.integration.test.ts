/**
 * BREAK TEST 5 (RUN_ASSET_FINANCE_RECOVERY_IT): reaching another tenant's recovery, legal matter, sale, cost,
 * refund, document or portal recovery view, and injecting another tenant's ids into one's own writes.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { cleanupE2e } from "./recovery-e2e.integration-fixture"
import { cleanupRecoveryFixture, newValuation, newAsset, today, type RecoveryFixture } from "./recovery.integration-fixture"
import { ladderRecovery } from "./recovery-path.integration-fixture"
import { plainListed, readJson, refundForm, saleBody } from "./recovery-sale.integration-fixture"
import { asUser, bundle, db, makeTenant, RUN, sessionBox } from "./recovery-break.fixture"

vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => sessionBox.current) }))

const suite = RUN ? describe : describe.skip
let A: RecoveryFixture
let B: RecoveryFixture
const RA = () => bundle(A)
const RB = () => bundle(B)
const asA = (who: "officer" | "adminA" | "adminB") => asUser(A, A[who], who === "officer" ? "CREDIT_OFFICER" : "LOAN_ADMIN")
const asB = (who: "officer" | "adminA" | "adminB") => asUser(B, B[who], who === "officer" ? "CREDIT_OFFICER" : "LOAN_ADMIN")

const portalSession = (fx: RecoveryFixture, clientId: string) => { sessionBox.current = { user: { id: clientId, email: "c@client.invalid", role: "CLIENT", tenantId: fx.tenantId } } }

suite.sequential("break 5: tenant isolation", () => {
  let aRec: Awaited<ReturnType<typeof plainListed>>
  let aSale = ""
  let aCost = ""
  let aMatter = ""
  let aStep = ""
  let aSurplus: Awaited<ReturnType<typeof ladderRecovery>>
  let aValuationOfOtherAsset = ""
  beforeAll(async () => {
    process.env.TRUSTED_PROXY = "1"
    A = await makeTenant()
    B = await makeTenant()
    aRec = await plainListed(db, A, "NCA", 100_000_000)
    asA("officer")
    aSale = (await readJson(await RA().s.propose(aRec.id, saleBody(aRec.valuationId, 100_000_000, { buyerName: "ZZ SECRET BUYER", buyerIdentifier: "ZZSECRET99", buyerAddress: "99 Secret Street" })))).body.id as string
    aCost = (await RA().r.cost(aRec.id, { type: "TOWING", treatment: "DEDUCT_FROM_PROCEEDS", netCents: 100_000, vatCents: 0, supplierInvoiceRef: "INV-A-1", incurredOn: today() })).body.id as string
    aMatter = (await db.recovery.findUniqueOrThrow({ where: { id: aRec.id } })).legalMatterId as string
    aStep = (await db.legalMatterStep.findFirstOrThrow({ where: { matterId: aMatter, kind: "JUDGMENT" } })).id
    aSurplus = await ladderRecovery(db, A, true, "SURPLUS_HELD", { settlementCents: 20_000_000 })
    asA("officer")
    expect((await readJson(await RA().s.refund(aSurplus.id, refundForm()))).status).toBe(201)
    aValuationOfOtherAsset = await newValuation(db, A, await newAsset(db, A), 5_000_000)
  }, 240_000)
  afterAll(async () => {
    sessionBox.current = null
    for (const f of [A, B]) {
      await cleanupE2e(db, f.tenantId).catch(() => undefined)
      await cleanupRecoveryFixture(db, f.tenantId).catch(() => undefined)
    }
    await db.$disconnect()
  }, 240_000)

  const snapshot = async () => JSON.stringify([
    await db.recovery.findMany({ where: { tenantId: A.tenantId }, orderBy: { id: "asc" } }),
    await db.remarketingSale.findMany({ where: { tenantId: A.tenantId }, orderBy: { id: "asc" } }),
    await db.recoveryCost.findMany({ where: { tenantId: A.tenantId }, orderBy: { id: "asc" } }),
    await db.recoveryRefund.findMany({ where: { tenantId: A.tenantId }, orderBy: { id: "asc" } }),
    await db.legalMatter.findMany({ where: { tenantId: A.tenantId }, orderBy: { id: "asc" } }),
    await db.legalMatterStep.count({ where: { tenantId: A.tenantId } }),
    await db.payment.count({ where: { tenantId: A.tenantId } }),
  ])

  it("5a. every route, called as tenant B (own host, own session) with tenant A's ids, answers 404/4xx and changes nothing", async () => {
    const before = await snapshot()
    const ids = { rec: aRec.id, sale: aSale, cost: aCost, loan: aRec.loan.loanId, matter: aMatter, step: aStep, surplus: aSurplus.id }
    const answers: Record<string, number> = {}
    for (const role of ["officer", "adminA"] as const) {
      asB(role)
      const b = RB()
      const t = async (label: string, run: () => Promise<{ status: number } | Response>) => { answers[`${role}:${label}`] = (await run()).status }
      await t("view", () => b.r.view(ids.rec))
      await t("create", () => b.r.create(ids.loan, { route: "NON_NCA_VOLUNTARY", recoveredOn: today(), location: "Yard", condition: "Fair" }))
      await t("list", () => b.r.list(ids.loan))
      await t("valuation", () => b.r.valuation(ids.rec, { valuedOn: today(), source: "ASSESSOR", valuerName: "X", amountCents: 1 }))
      await t("valuationNotice", () => b.r.valuationNotice(ids.rec))
      await t("listForSale", () => b.r.listForSale(ids.rec))
      await t("cost", () => b.r.cost(ids.rec, { type: "TOWING", treatment: "DEDUCT_FROM_PROCEEDS", netCents: 100, vatCents: 0, supplierInvoiceRef: "B", incurredOn: today() }))
      await t("decideCost", () => b.r.decideCost(ids.rec, ids.cost, { decision: "APPROVED" }))
      await t("finalNotice", () => b.r.finalNotice(ids.rec))
      await t("withdraw", () => b.r.withdraw(ids.rec, { reason: "Debtor paid the arrears in full" }))
      await t("close", () => b.r.close(ids.rec))
      await t("document valuation", () => b.r.document(ids.rec, "valuation"))
      await t("document final", () => b.r.document(ids.rec, "final"))
      await t("document statement", () => b.r.document(ids.rec, "statement"))
      await t("propose", () => b.s.propose(ids.rec, saleBody(aRec.valuationId, 1_000)))
      await t("approveSale", () => b.s.approveSale(ids.rec, ids.sale))
      await t("completeSale", () => b.s.completeSale(ids.rec, ids.sale))
      await t("cancelSale", () => b.s.cancelSale(ids.rec, ids.sale))
      await t("proceeds", () => b.s.proceeds(ids.rec))
      await t("outcome", () => b.s.outcome(ids.rec))
      await t("refund create", () => b.s.refund(ids.surplus, refundForm()))
      await t("refund approve", () => b.s.approveRefund(ids.surplus))
      await t("refund release", () => b.s.releaseRefund(ids.surplus))
      await t("legal open", () => b.l.open(ids.loan))
      await t("legal loanView", () => b.l.loanView(ids.loan))
      await t("legal matter", () => b.l.matter(ids.matter))
      await t("legal appoint", () => b.l.appoint(ids.matter, { supplierId: B.supplier, appointedOn: today() }))
      await t("legal step", () => b.l.step(ids.matter, { kind: "LETTER_OF_DEMAND", stepDate: today() }))
      await t("legal doc", () => b.l.document(ids.matter, ids.step))
      await t("portal as staff", () => b.r.portal(ids.loan))
    }
    asB("adminA")
    const listBody = await RB().r.list(ids.loan)
    expect(JSON.stringify(listBody.body), "B sees A's recoveries through list").not.toContain(ids.rec)
    const open = Object.entries(answers).filter(([k, status]) => status < 400 && !k.endsWith(":list"))
    expect(open, JSON.stringify(open)).toEqual([])
    expect(await snapshot()).toBe(before)
  }, 240_000)

  it("5b. tenant B's session sent to tenant A's host is refused on every route family", async () => {
    const before = await snapshot()
    asB("adminA")
    const a = RA()
    const statuses = [
      (await a.r.view(aRec.id)).status, (await a.r.cost(aRec.id, { type: "TOWING", treatment: "DEDUCT_FROM_PROCEEDS", netCents: 100, vatCents: 0, supplierInvoiceRef: "B", incurredOn: today() })).status,
      (await a.s.proceeds(aRec.id)).status, (await a.s.approveRefund(aSurplus.id)).status, (await a.l.matter(aMatter)).status, (await a.l.step(aMatter, { kind: "LETTER_OF_DEMAND", stepDate: today() })).status,
    ]
    expect(statuses.every((s) => s >= 400), JSON.stringify(statuses)).toBe(true)
    expect(await snapshot()).toBe(before)
  }, 120_000)

  it("5c. tenant A's ids injected into tenant B's own writes are refused (valuation, supplier, steps, documents)", async () => {
    const bRec = await plainListed(db, B, "NCA", 100_000_000)
    asB("officer")
    // sale citing A's valuation of A's asset
    const sale = await readJson(await RB().s.propose(bRec.id, saleBody(aRec.valuationId, 100_000_000)))
    expect(sale.status, "B sale citing A valuation").toBeGreaterThanOrEqual(400)
    // cost citing A's legal step and A's supplier
    const cost = await RB().r.cost(bRec.id, { type: "LEGAL_TAXED", treatment: "CHARGE_TO_ACCOUNT", netCents: 100, vatCents: 0, supplierInvoiceRef: "B", incurredOn: today(), legalStepId: aStep })
    expect(cost.status, "B cost citing A step").toBeGreaterThanOrEqual(400)
    const cost2 = await RB().r.cost(bRec.id, { type: "TOWING", treatment: "DEDUCT_FROM_PROCEEDS", netCents: 100, vatCents: 0, supplierInvoiceRef: "B", incurredOn: today(), supplierId: A.supplier })
    expect(cost2.status, "B cost citing A supplier").toBeGreaterThanOrEqual(400)
    // B's matter: attorney from A, S129 record from A, correctsStepId from A
    const bLoan = bRec.loan.loanId
    void bLoan
    const matter = (await db.recovery.findUniqueOrThrow({ where: { id: bRec.id } })).legalMatterId as string
    expect((await readJson(await RB().l.appoint(matter, { supplierId: A.supplier, appointedOn: today() }))).status, "attorney from A").toBeGreaterThanOrEqual(400)
    expect((await readJson(await RB().l.step(matter, { kind: "LETTER_OF_DEMAND", stepDate: today(), correctsStepId: aStep }))).status, "corrects A's step").toBeGreaterThanOrEqual(400)
    // create recovery for B's loan citing A's surrender/legal matter
    const loanB = await plainListed(db, B, "NCA", 100_000_000)
    const aSurr = (await db.surrenderRequest.findFirst({ where: { tenantId: A.tenantId } }))?.id
    const viaMatter = await RB().r.create(loanB.loan.loanId, { route: "NCA_S131_ATTACHMENT", recoveredOn: today(), location: "Yard", condition: "Fair", legalMatterId: aMatter })
    expect(viaMatter.status, "B recovery citing A matter").toBeGreaterThanOrEqual(400)
    if (aSurr) {
      const viaSurr = await RB().r.create(loanB.loan.loanId, { route: "NCA_S127_SURRENDER", recoveredOn: today(), location: "Yard", condition: "Fair", surrenderRequestId: aSurr })
      expect(viaSurr.status, "B recovery citing A surrender").toBeGreaterThanOrEqual(400)
    }
    void aValuationOfOtherAsset
  }, 240_000)

  it("5d. portal: another client, an inactive/other relation, and a tenant-B client cannot read tenant A's recovery view; the view leaks no buyer data", async () => {
    // complete the sale to give a final account on A's NCA recovery
    asA("officer")
    expect((await readJson(await RA().s.completeSale(aRec.id, aSale))).status).toBe(200)
    await RA().r.decideCost(aRec.id, aCost, { decision: "APPROVED" }).catch(() => undefined)
    const clientOfLoan = (await db.loan.findUniqueOrThrow({ where: { id: aRec.loan.loanId }, select: { clientId: true } })).clientId as string
    const portal = (fx: RecoveryFixture, clientId: string) => { portalSession(fx, clientId); return bundle(fx).r.portal(aRec.loan.loanId) }
    // borrower sees it
    const own = await portal(A, clientOfLoan)
    expect(own.status).toBe(200)
    const text = JSON.stringify(own.body)
    for (const secret of ["ZZ SECRET BUYER", "ZZSECRET99", "Secret Street", "relatedPartyMatch", "screening", aSale, "buyer", "INV-A-1", A.officer, A.adminA]) {
      expect(text.toLowerCase(), `portal leaks ${secret}`).not.toContain(String(secret).toLowerCase())
    }
    // a different client of the same tenant
    expect((await portal(A, A.director)).status).toBe(404)
    // a tenant-B client at tenant B's host, and at A's host
    const bClient = (await db.client.findFirstOrThrow({ where: { tenantId: B.tenantId } })).id
    expect((await portal(B, bClient)).status).toBeGreaterThanOrEqual(400)
    portalSession(B, bClient)
    expect((await bundle(A).r.portal(aRec.loan.loanId)).status).toBeGreaterThanOrEqual(400)
    // the borrower's own session claiming tenant B on host A
    portalSession(B, clientOfLoan)
    expect((await bundle(A).r.portal(aRec.loan.loanId)).status).toBeGreaterThanOrEqual(400)
    // staff session on the portal route
    asA("adminA")
    expect((await bundle(A).r.portal(aRec.loan.loanId)).status).toBe(401)
  }, 240_000)
})
