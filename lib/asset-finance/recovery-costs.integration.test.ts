/**
 * Slice 4a recovery routes, part 2, through the real handlers against a
 * migrated Postgres: opening a recovery, the cost ledger (two people, VAT at
 * the rate in force, the database's allow-lists answered 409), withdrawal
 * (the asset is freed), closing a shortfall, the portal view (never the
 * buyer), cross-tenant ids (404) and the roles (READONLY 403, no session 401).
 *
 *   RUN_ASSET_FINANCE_RECOVERY_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/asset-finance/recovery-costs.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import { PATCH as reversePayment } from "@/app/api/payments/[id]/reverse/route"
import type { SessionUser } from "./payout-booking.integration-fixture"
import { testSetup } from "./lease-servicing.integration-fixture"
import {
  addStep, cleanupRecoveryFixture, courtMatter, createRecoveryFixture, legalDocument, newLoan, newRecovery, recoveryFixtureTenantId, today, type RecoveryFixture,
} from "./recovery.integration-fixture"
import { syntheticSaIdNumber } from "./synthetic-sa-id.integration-fixture"
import { loadCostFormData } from "@/components/asset-finance/recovery/recovery-panel-data"
import { ladderRecovery } from "./recovery-path.integration-fixture"
import { recoveryRoutes } from "./recovery-routes.integration-fixture"

const { session } = vi.hoisted(() => ({ session: { current: null as null | { user: SessionUser } } }))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => session.current) }))

const RUN = process.env.RUN_ASSET_FINANCE_RECOVERY_IT === "1"
const suite = RUN ? describe : describe.skip
const db = RUN ? new PrismaClient() : null
const t = randomUUID().replaceAll("-", "").slice(0, 16)
const t2 = randomUUID().replaceAll("-", "").slice(0, 16)
let fx: RecoveryFixture
let other: RecoveryFixture
const database = (): PrismaClient => {
  if (!db) throw new Error("RUN_ASSET_FINANCE_RECOVERY_IT=1 is required")
  return db
}
const as = (f: RecoveryFixture, id: string, role: string) => { session.current = { user: { id, email: `${id}@recovery-it.test`, role, tenantId: f.tenantId } } }
const officer = () => as(fx, fx.officer, "CREDIT_OFFICER")
const admin = () => as(fx, fx.adminA, "LOAN_ADMIN")
const routes = () => recoveryRoutes(fx.host)
const recoveryOf = (id: string) => database().recovery.findUniqueOrThrow({ where: { id } })
const cost = (over: Record<string, unknown> = {}) => ({
  type: "TOWING", treatment: "DEDUCT_FROM_PROCEEDS", netCents: 200_000, vatCents: 0, supplierInvoiceRef: `INV-${randomUUID().slice(0, 6)}`, incurredOn: today(), ...over,
})
const create = (over: Record<string, unknown> = {}) => ({ route: "NON_NCA_VOLUNTARY", recoveredOn: today(), location: "TEST Yard", condition: "Synthetic: fair", ...over })

suite.sequential("recovery routes: create, costs, withdraw, close, portal, roles (real Postgres)", () => {
  beforeAll(async () => {
    process.env.TRUSTED_PROXY = "1"
    fx = await createRecoveryFixture(database(), t)
    other = await createRecoveryFixture(database(), t2)
  }, 180_000)
  afterAll(async () => {
    if (!db) return
    await cleanupRecoveryFixture(db, recoveryFixtureTenantId(t))
    await cleanupRecoveryFixture(db, recoveryFixtureTenantId(t2))
    await db.$disconnect()
  }, 180_000)

  it("opens a NON_NCA voluntary recovery, lists it, and refuses a route that does not match the regime", async () => {
    officer()
    const loan = await newLoan(database(), fx, "NON_NCA")
    const r = routes()
    const created = await r.create(loan.loanId, create())
    expect(created.status).toBe(201)
    expect((await r.list(loan.loanId)).body.recoveries).toMatchObject([{ id: created.body.id, route: "NON_NCA_VOLUNTARY", status: "RECOVERED" }])
    // One open recovery per loan.
    expect((await r.create(loan.loanId, create())).status).toBe(409)
    const nca = await newLoan(database(), fx, "NCA")
    const mismatch = await r.create(nca.loanId, create())
    expect(mismatch.status).toBe(409)
    expect(String(mismatch.body.error)).toMatch(/route must match the loan's NCA regime/)
    expect((await r.create(loan.loanId, create({ route: "SELL_IT" }))).status).toBe(400)
    // A meter reading belongs to a lease.
    const another = await newLoan(database(), fx, "NON_NCA")
    const reading = await r.create(another.loanId, create({ meterReading: { value: 100 } }))
    expect(reading.status).toBe(409)
    expect(reading.body.error).toBe("A meter reading applies to a lease only")
    expect(await database().recovery.count({ where: { loanId: another.loanId } })).toBe(0)
    expect((await r.view(created.body.id as string)).body).toMatchObject({ route: "NON_NCA_VOLUNTARY", status: "RECOVERED", costTotals: { deducted: 0, charged: 0 } })
  }, 120_000)

  it("records a cost PENDING; VAT at the rate in force; the database's allow-lists answer 409", async () => {
    const loan = await newLoan(database(), fx, "NCA")
    const matterId = await courtMatter(database(), fx, loan)
    const id = await newRecovery(database(), fx, loan, "NCA_S131_ATTACHMENT", { legalMatterId: matterId })
    const vendor = (await database().supplier.create({ data: { tenantId: fx.tenantId, name: "TEST Tow (Pty) Ltd", vatNumber: "4000000099" } })).id
    const plain = (await database().supplier.create({ data: { tenantId: fx.tenantId, name: "TEST Sole Tow" } })).id
    const r = routes()

    as(fx, "nobody", "READONLY")
    expect((await r.cost(id, cost())).status).toBe(403)
    officer()
    expect((await r.cost(id, cost({ netCents: -5 }))).status).toBe(400)
    // 10001 at 15% is 1500.15: 1500 half-up.
    const wrong = await r.cost(id, cost({ supplierId: vendor, netCents: 10_001, vatCents: 1_501 }))
    expect(wrong.status).toBe(409)
    expect(String(wrong.body.error)).toMatch(/1500 cents/)
    const vat = await r.cost(id, cost({ supplierId: vendor, netCents: 10_001, vatCents: 1_500 }))
    expect(vat.status).toBe(201)
    expect(await database().recoveryCost.findUniqueOrThrow({ where: { id: vat.body.id as string } }))
      .toMatchObject({ grossCents: 11_501, status: "PENDING", recordedById: fx.officer, approvedById: null, approvedAt: null })
    const nonVendor = await r.cost(id, cost({ supplierId: plain, vatCents: 300 }))
    expect(nonVendor.status).toBe(409)
    const second = await r.cost(id, cost({ supplierId: plain }))
    expect(second.status).toBe(201)
    expect((await r.cost(id, cost({ supplierId: "nobody" }))).status).toBe(404)

    // NCA: taxed legal costs name an evidenced judgment or settlement step (the database's sentence, said before it); other types are never charged to the account.
    const EVIDENCED = /Taxed legal costs name the evidenced judgment or settlement step/
    const taxed = await r.cost(id, cost({ type: "LEGAL_TAXED", treatment: "CHARGE_TO_ACCOUNT" }))
    expect(taxed.status).toBe(409)
    expect(String(taxed.body.error)).toMatch(EVIDENCED)
    const judgment = await database().legalMatterStep.findFirstOrThrow({ where: { matterId, kind: "JUDGMENT" } })
    const bare = await addStep(database(), fx, matterId, "SETTLED") // no legal document on file
    const unevidenced = await r.cost(id, cost({ type: "LEGAL_TAXED", treatment: "CHARGE_TO_ACCOUNT", legalStepId: bare }))
    expect(unevidenced.status).toBe(409)
    expect(String(unevidenced.body.error)).toMatch(EVIDENCED)
    const legal = await r.cost(id, cost({ type: "LEGAL_TAXED", treatment: "CHARGE_TO_ACCOUNT", legalStepId: judgment.id }))
    expect(legal.status).toBe(201)
    // A corrected step no longer counts, and the cost form offers only the evidenced, uncorrected steps.
    const corrected = await addStep(database(), fx, matterId, "JUDGMENT", today(), { correctsStepId: judgment.id, evidenceDocumentId: await legalDocument(database(), fx) })
    const stale = await r.cost(id, cost({ type: "LEGAL_TAXED", treatment: "CHARGE_TO_ACCOUNT", legalStepId: judgment.id }))
    expect(stale.status).toBe(409)
    expect(String(stale.body.error)).toMatch(EVIDENCED)
    expect((await loadCostFormData(fx.tenantId, loan.loanId)).legalSteps.map((o) => o.value)).toEqual([corrected])
    const charged = await r.cost(id, cost({ treatment: "CHARGE_TO_ACCOUNT" }))
    expect(charged.status).toBe(409)
    expect(String(charged.body.error)).toMatch(/Only taxed legal costs are charged to an NCA account/)
    expect((await r.cost(id, cost({ type: "LEGAL_CONTRACTUAL" }))).status).toBe(409)

    // Pending costs are listed apart and count for nothing until decided.
    const pending = (await r.view(id)).body as { costs: unknown[]; pendingCosts: { status: string }[]; costTotals: { deducted: number; charged: number } }
    expect(pending.costs).toHaveLength(0)
    expect(pending.pendingCosts.map((c) => c.status)).toEqual(["PENDING", "PENDING", "PENDING"])
    expect(pending.costTotals).toEqual({ deducted: 0, charged: 0 })

    // Not after the proceeds are applied.
    const applied = await ladderRecovery(database(), fx, false, "PROCEEDS_APPLIED")
    const late = await r.cost(applied.id, cost())
    expect(late.status).toBe(409)
    expect(String(late.body.error)).toMatch(/Costs are recorded before the sale proceeds are applied/)

    // Decided by someone else: approved costs count, a rejected one is listed but counts for nothing.
    expect((await r.decideCost(id, vat.body.id as string, { decision: "APPROVED" })).status).toBe(403)
    admin()
    expect((await r.decideCost(id, vat.body.id as string, { decision: "MAYBE" })).status).toBe(400)
    expect((await r.decideCost(id, "nobody", { decision: "APPROVED" })).status).toBe(404)
    expect((await r.decideCost(id, vat.body.id as string, { decision: "APPROVED" })).status).toBe(200)
    expect((await r.decideCost(id, legal.body.id as string, { decision: "APPROVED" })).status).toBe(200)
    expect((await r.decideCost(id, second.body.id as string, { decision: "REJECTED" })).status).toBe(200)
    expect(await database().recoveryCost.findUniqueOrThrow({ where: { id: vat.body.id as string } })).toMatchObject({ status: "APPROVED", approvedById: fx.adminA })
    const again = await r.decideCost(id, vat.body.id as string, { decision: "REJECTED" })
    expect(again.status).toBe(409)
    expect(again.body.error).toBe("This cost has already been decided")
    const decided = (await r.view(id)).body as { costs: { status: string }[]; pendingCosts: unknown[]; costTotals: { deducted: number; charged: number } }
    expect(decided.pendingCosts).toHaveLength(0)
    expect(decided.costs.map((c) => c.status).sort()).toEqual(["APPROVED", "APPROVED", "REJECTED"])
    expect(decided.costTotals).toEqual({ deducted: 11_501, charged: 200_000 })
    const audits = await database().auditLog.findMany({ where: { tenantId: fx.tenantId, entityId: id, action: { in: ["ASSET_RECOVERY_COST_RECORDED", "ASSET_RECOVERY_COST_DECIDED"] } } })
    expect(audits.filter((a) => a.action === "ASSET_RECOVERY_COST_RECORDED")).toHaveLength(3)
    expect(audits.filter((a) => a.action === "ASSET_RECOVERY_COST_DECIDED")).toHaveLength(3)
  }, 120_000)

  it("a cost is decided by someone other than its recorder, and the application says so before the database does", async () => {
    const loan = await newLoan(database(), fx, "NON_NCA")
    const id = await newRecovery(database(), fx, loan, "NON_NCA_VOLUNTARY")
    const r = routes()
    admin()
    const recorded = await r.cost(id, cost())
    expect(recorded.status).toBe(201)
    const own = await r.decideCost(id, recorded.body.id as string, { decision: "APPROVED" })
    expect(own.status).toBe(409)
    expect(own.body.error).toBe("A cost is decided by someone other than the person who recorded it")
    expect(await database().recoveryCost.findUniqueOrThrow({ where: { id: recorded.body.id as string } })).toMatchObject({ status: "PENDING", approvedById: null })
    as(fx, fx.adminB, "LOAN_ADMIN")
    expect((await r.decideCost(id, recorded.body.id as string, { decision: "APPROVED" })).status).toBe(200)
  }, 120_000)

  it("withdraws a recovery with a reason and frees the asset", async () => {
    officer()
    const loan = await newLoan(database(), fx, "NON_NCA")
    const id = await newRecovery(database(), fx, loan, "NON_NCA_VOLUNTARY")
    const asset = () => database().financedAsset.findUniqueOrThrow({ where: { id: loan.assetId } }).then((a) => a.lessorStatus)
    expect(await asset()).toBe("RECOVERED")
    const r = routes()
    expect((await r.withdraw(id, { reason: "short" })).status).toBe(409)
    expect((await r.withdraw(id, {})).status).toBe(400)
    expect(await asset()).toBe("RECOVERED")
    expect((await r.withdraw(id, { reason: "The debtor paid the arrears in full" })).status).toBe(200)
    expect(await recoveryOf(id)).toMatchObject({ status: "WITHDRAWN", withdrawnReason: "The debtor paid the arrears in full" })
    expect(await asset()).toBeNull()
    expect((await r.withdraw(id, { reason: "Withdrawn a second time" })).status).toBe(409)
    const sold = await ladderRecovery(database(), fx, false, "SOLD")
    expect((await r.withdraw(sold.id, { reason: "Withdrawing after the sale" })).status).toBe(409)
  }, 120_000)

  it("closes an open shortfall only once the loan is settled or written off", async () => {
    officer()
    const { id, loan } = await ladderRecovery(database(), fx, true, "SHORTFALL_OPEN")
    const r = routes()
    const early = await r.close(id)
    expect(early.status).toBe(409)
    expect(String(early.body.error)).toMatch(/settled or written off/)
    await testSetup(database(), [`UPDATE "Loan" SET "status" = 'WRITTEN_OFF' WHERE "id" = $1`, loan.loanId])
    expect((await r.close(id)).status).toBe(200)
    expect(await recoveryOf(id)).toMatchObject({ status: "CLOSED" })
    expect((await r.close(id)).status).toBe(409)
    const held = await ladderRecovery(database(), fx, false, "SURPLUS_HELD", { settlementCents: 50_000_000 })
    expect((await r.close(held.id)).status).toBe(409)
  }, 120_000)

  it("shows the consumer their account and never the buyer; another client gets 404", async () => {
    const { id, loan } = await ladderRecovery(database(), fx, true, "FINAL_NOTICE_ISSUED", { costs: [{ type: "TOWING", treatment: "DEDUCT_FROM_PROCEEDS", grossCents: 500_000 }] })
    const clientId = (await database().loan.findUniqueOrThrow({ where: { id: loan.loanId } })).clientId ?? ""
    const stranger = (await database().client.create({ data: {
      tenantId: fx.tenantId, firstName: "TEST", lastName: "Stranger", email: `stranger-${t}@client.invalid`, phone: `0009${t.slice(0, 6)}`, idNumber: syntheticSaIdNumber(), popiaConsentGiven: true,
    } })).id
    const r = routes()
    as(fx, clientId, "CLIENT")
    const portal = await r.portal(loan.loanId)
    expect(portal.status).toBe(200)
    expect(portal.body.recovery).toMatchObject({ status: "FINAL_NOTICE_ISSUED", notices: { valuation: true, final: true }, finalAccount: { grossProceedsCents: 120_000_000, deductedCostsCents: 500_000 } })
    const text = JSON.stringify(portal.body)
    for (const secret of ["TEST Buyer", "7001015800084", "2 Buyer Street", "buyer"]) expect(text).not.toContain(secret)
    expect((portal.body.recovery as { finalAccount: { costs: unknown[] } }).finalAccount.costs).toEqual([{ label: "Towing and transport", grossCents: 500_000, treatment: "DEDUCT_FROM_PROCEEDS" }])
    as(fx, stranger, "CLIENT")
    expect((await r.portal(loan.loanId)).status).toBe(404)
    session.current = null
    expect((await r.portal(loan.loanId)).status).toBe(401)
    as(fx, fx.officer, "CREDIT_OFFICER")
    expect((await r.portal(loan.loanId)).status).toBe(401)
    expect((await r.view(id)).body).toMatchObject({ sales: [{ buyerName: "TEST Buyer" }] })
  }, 120_000)

  it("refuses to reverse a recovery's sale-proceeds receipt, with a friendly 409 and nothing written", async () => {
    const { id } = await ladderRecovery(database(), fx, true, "PROCEEDS_APPLIED")
    const paymentId = (await recoveryOf(id)).proceedsPaymentId ?? ""
    expect(paymentId).not.toBe("")
    admin()
    const reverse = () => reversePayment(new NextRequest(`http://${fx.host}/api/payments/${paymentId}/reverse`, {
      method: "PATCH", headers: { host: fx.host, "content-type": "application/json" }, body: JSON.stringify({ reason: "Bank returned the deposit" }),
    }), { params: Promise.resolve({ id: paymentId }) })
    const response = await reverse()
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: "This receipt is a recovery's sale proceeds and cannot be reversed" })
    expect(await database().payment.findUniqueOrThrow({ where: { id: paymentId } })).toMatchObject({ reversed: false, reversedAt: null })
    expect(await database().auditLog.count({ where: { tenantId: fx.tenantId, entityId: paymentId, action: "PAYMENT_REVERSED" } })).toBe(0)
  }, 120_000)

  it("shows the consumer the valuation only once it is a notice (NCA) or the asset is listed (NON_NCA)", async () => {
    const portalAs = async (loanId: string) => {
      const clientId = (await database().loan.findUniqueOrThrow({ where: { id: loanId } })).clientId
      const director = (await database().entityRelationship.findFirst({ where: { tenantId: fx.tenantId, entity: { loans: { some: { id: loanId } } }, role: "DIRECTOR" } }))?.clientId
      as(fx, clientId ?? director ?? "", "CLIENT")
      return (await routes().portal(loanId)).body.recovery as { valuationAmountCents: number | null; status: string }
    }
    const shown = async (nca: boolean, to: "VALUED" | "VALUATION_NOTICE_ISSUED" | "LISTED") => {
      const { loan } = await ladderRecovery(database(), fx, nca, to, { valuationCents: 98_700_000 })
      return portalAs(loan.loanId)
    }
    expect((await shown(true, "VALUED")).valuationAmountCents).toBeNull()
    expect((await shown(true, "VALUATION_NOTICE_ISSUED")).valuationAmountCents).toBe(98_700_000)
    expect((await shown(false, "VALUED")).valuationAmountCents).toBeNull()
    expect((await shown(false, "LISTED")).valuationAmountCents).toBe(98_700_000)
  }, 120_000)

  it("keeps tenants apart (404) and enforces the roles", async () => {
    officer()
    const loan = await newLoan(database(), fx, "NON_NCA")
    const id = await newRecovery(database(), fx, loan, "NON_NCA_VOLUNTARY")
    const r = routes()
    as(other, other.adminA, "LOAN_ADMIN")
    const foreign = recoveryRoutes(other.host)
    expect((await foreign.view(id)).status).toBe(404)
    expect((await foreign.list(loan.loanId)).status).toBe(404)
    expect((await foreign.valuation(id, { valuedOn: today(), source: "ASSESSOR", valuerName: "TEST", amountCents: 1 })).status).toBe(404)
    expect((await foreign.listForSale(id)).status).toBe(404)
    expect((await foreign.cost(id, cost())).status).toBe(404)
    expect((await foreign.decideCost(id, "any", { decision: "APPROVED" })).status).toBe(404)
    expect((await foreign.withdraw(id, { reason: "Not my recovery to withdraw" })).status).toBe(404)
    expect((await foreign.close(id)).status).toBe(404)
    expect((await foreign.create(loan.loanId, create())).status).toBe(404)
    expect((await foreign.document(id, "statement")).status).toBe(404)
    expect((await recoveryOf(id)).status).toBe("RECOVERED")

    as(fx, fx.officer, "READONLY")
    expect((await r.view(id)).status).toBe(200)
    for (const attempt of [r.create(loan.loanId, create()), r.listForSale(id), r.withdraw(id, { reason: "A reasonable reason" }), r.close(id), r.valuationNotice(id), r.finalNotice(id)]) {
      expect((await attempt).status).toBe(403)
    }
    session.current = null
    expect((await r.view(id)).status).toBe(401)
    expect((await r.create(loan.loanId, create())).status).toBe(401)
  }, 120_000)
})
