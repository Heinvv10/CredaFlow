/**
 * Slice 4a sale rules through the real routes (real migrated Postgres): a sale
 * under the highest independent valuation needs a reason and a second approver;
 * a buyer who matches the borrower, a related client or a COI declaration is
 * flagged without a name or ID number reaching the audit log, and needs the
 * second approver too; the proposer cannot approve; one COMPLETED sale per
 * recovery; a completed sale, its VAT event and its tax invoice are immutable;
 * a cross-tenant id is a 404 and a READONLY session a 403 on every write.
 * The sale policy is UNTESTED against the law: these prove the rules as written.
 *
 *   RUN_ASSET_FINANCE_RECOVERY_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/asset-finance/recovery-sale-rules.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { sastCalendarDate } from "@/lib/date/sast"
import { cleanupRecoveryFixture, createRecoveryFixture, newValuation, recoveryFixtureTenantId, type RecoveryFixture } from "./recovery.integration-fixture"
import { costData, recordDecidedCost } from "./recovery-path.integration-fixture"
import { plainListed, readJson, refundForm, saleBody, saleRoutes } from "./recovery-sale.integration-fixture"
import type { SessionUser } from "./payout-booking.integration-fixture"

const { session } = vi.hoisted(() => ({ session: { current: null as null | { user: SessionUser } } }))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => session.current) }))

const RUN = process.env.RUN_ASSET_FINANCE_RECOVERY_IT === "1"
const suite = RUN ? describe : describe.skip
const db = RUN ? new PrismaClient() : null
const t = randomUUID().replaceAll("-", "").slice(0, 16)
let fx: RecoveryFixture
let other: { tenantId: string; host: string; admin: string }
const database = (): PrismaClient => {
  if (!db) throw new Error("RUN_ASSET_FINANCE_RECOVERY_IT=1 is required")
  return db
}
type Role = "READONLY" | "CREDIT_OFFICER" | "LOAN_ADMIN"
const as = (id: string, role: Role, tenantId = fx.tenantId) => { session.current = { user: { id, email: `${id}@recovery-it.test`, role, tenantId } } }
const officer = () => as(fx.officer, "CREDIT_OFFICER")
const adminA = () => as(fx.adminA, "LOAN_ADMIN")
const adminB = () => as(fx.adminB, "LOAN_ADMIN")
const routes = () => saleRoutes(fx.host)
const propose = async (rec: { id: string; valuationId: string }, price: number, over: Record<string, unknown> = {}) =>
  readJson(await routes().propose(rec.id, saleBody(rec.valuationId, price, over)))
const auditText = async (entityIds: string[]) =>
  JSON.stringify(await database().auditLog.findMany({ where: { tenantId: fx.tenantId, entityId: { in: entityIds } }, select: { action: true, newValue: true } }))

suite.sequential("remarketing sale rules (real Postgres, real routes)", () => {
  beforeAll(async () => {
    fx = await createRecoveryFixture(database(), t)
    await database().vatConfig.create({ data: { tenantId: fx.tenantId, vatNumber: "4000000001", registeredName: "TEST Asset Credit (Pty) Ltd", address: "1 Synthetic Road, Johannesburg, 2000" } })
    const tenantId = `t_af_sale_other_${t}`
    other = { tenantId, host: `af-sale-other-${t}.sale-it.test`, admin: `admin-other-${t}` }
    await database().tenant.create({ data: { id: tenantId, slug: `af-sale-other-${t}`, name: "Other IT", domain: other.host } })
    await database().tenantConfig.create({ data: { tenantId, featureAssetFinance: true } })
    await database().user.create({ data: { id: other.admin, tenantId, email: `${other.admin}@staff.invalid`, password: "x", role: "LOAN_ADMIN" } })
  }, 120_000)

  afterAll(async () => {
    await database().coiDeclaration.deleteMany({ where: { tenantId: fx.tenantId } }).catch(() => undefined)
    await cleanupRecoveryFixture(database(), recoveryFixtureTenantId(t)).catch(() => undefined)
    await database().user.deleteMany({ where: { tenantId: other.tenantId } }).catch(() => undefined)
    await database().tenantConfig.deleteMany({ where: { tenantId: other.tenantId } }).catch(() => undefined)
    await database().tenant.deleteMany({ where: { id: other.tenantId } }).catch(() => undefined)
    await db?.$disconnect()
  }, 60_000)

  it("a price under the highest independent valuation needs a reason, then a second approver who is not the proposer", async () => {
    const rec = await plainListed(database(), fx, "NON_NCA", 100_000_000)
    officer()
    const atValuation = await propose(rec, 100_000_000)
    expect(atValuation).toMatchObject({ status: 201, body: { belowValuation: false, approvalRequired: false } })
    // No approval is needed (or allowed) for a sale at the valuation.
    adminA()
    expect((await readJson(await routes().approveSale(rec.id, atValuation.body.id as string))).status).toBe(409)

    officer()
    expect(await propose(rec, 99_999_999)).toMatchObject({ status: 409 })
    expect(await propose(rec, 99_999_999, { belowValuationReason: "short" })).toMatchObject({ status: 409 })
    adminA()
    const below = await propose(rec, 99_999_999, { belowValuationReason: "Damaged chassis found on inspection" })
    expect(below).toMatchObject({ status: 201, body: { belowValuation: true, relatedPartyMatch: false, approvalRequired: true } })
    const saleId = below.body.id as string

    expect((await readJson(await routes().completeSale(rec.id, saleId))).status).toBe(409) // not approved
    expect((await readJson(await routes().approveSale(rec.id, saleId))).status).toBe(409) // the proposer cannot approve
    officer()
    expect((await readJson(await routes().approveSale(rec.id, saleId))).status).toBe(403) // approval needs decide_asset_finance
    adminB()
    expect((await readJson(await routes().approveSale(rec.id, saleId))).status).toBe(200)
    expect((await readJson(await routes().approveSale(rec.id, saleId))).status).toBe(409) // once
    officer()
    expect((await readJson(await routes().completeSale(rec.id, saleId))).status).toBe(200)
    expect(await database().remarketingSale.findUniqueOrThrow({ where: { id: saleId } })).toMatchObject({ status: "COMPLETED", approvedById: fx.adminB, createdById: fx.adminA })
  }, 120_000)

  it("refuses a valuation that is internal, stale or another asset's", async () => {
    const rec = await plainListed(database(), fx, "NON_NCA")
    officer()
    const internal = await newValuation(database(), fx, (await database().recovery.findUniqueOrThrow({ where: { id: rec.id } })).assetId, 200_000_000, "INTERNAL")
    expect(await propose({ id: rec.id, valuationId: internal }, 150_000_000)).toMatchObject({ status: 409, body: { error: expect.stringMatching(/independent/) } })
    const asset = (await database().recovery.findUniqueOrThrow({ where: { id: rec.id } })).assetId
    const old = await newValuation(database(), fx, asset, 100_000_000, "ASSESSOR", sastCalendarDate(new Date(Date.now() - 90 * 86_400_000)))
    expect(await propose({ id: rec.id, valuationId: old }, 150_000_000)).toMatchObject({ status: 409, body: { error: expect.stringMatching(/within \d+ days/) } })
    const elsewhere = await plainListed(database(), fx, "NON_NCA")
    expect(await propose({ id: rec.id, valuationId: elsewhere.valuationId }, 150_000_000)).toMatchObject({ status: 409 })
  }, 120_000)

  it("flags a buyer carrying the borrower's ID, a related client's name or a COI conflict, with no name or ID in the audit log", async () => {
    const nca = await plainListed(database(), fx, "NCA", 50_000_000)
    officer()
    const byId = await propose(nca, 60_000_000, { buyerIdentifier: nca.loan.borrowerKey })
    expect(byId).toMatchObject({ status: 201, body: { belowValuation: false, relatedPartyMatch: true, approvalRequired: true } })
    const sale = await database().remarketingSale.findUniqueOrThrow({ where: { id: byId.body.id as string } })
    expect(sale.screeningResult).toMatchObject({ match: true, matches: expect.arrayContaining([{ kind: "BORROWER", on: "IDENTIFIER" }]) })
    const audit = await auditText([byId.body.id as string])
    expect(audit).toContain("ASSET_REMARKETING_RELATED_PARTY_FLAGGED")
    expect(audit).not.toContain(nca.loan.borrowerKey)
    expect(audit).not.toContain("TEST Buyer")
    expect(JSON.stringify(sale.screeningResult)).not.toContain(nca.loan.borrowerKey)
    expect((await readJson(await routes().completeSale(nca.id, byId.body.id as string))).status).toBe(409)
    adminA()
    expect((await readJson(await routes().approveSale(nca.id, byId.body.id as string))).status).toBe(200)
    officer()
    expect((await readJson(await routes().completeSale(nca.id, byId.body.id as string))).status).toBe(200)

    const non = await plainListed(database(), fx, "NON_NCA", 50_000_000)
    expect(await propose(non, 60_000_000, { buyerName: "test DIRECTOR", buyerIdentifier: "9999999999999" })).toMatchObject({ status: 201, body: { relatedPartyMatch: true } })
    await database().coiDeclaration.create({ data: { tenantId: fx.tenantId, userId: fx.adminB, year: Number(sastCalendarDate(new Date()).slice(0, 4)), hasConflict: true, details: "Cousin owns TEST Cousin Autos" } })
    const coi = await propose(non, 60_000_000, { buyerName: "Test Cousin Autos", buyerIdentifier: "8888888888888" })
    expect(coi).toMatchObject({ status: 201, body: { relatedPartyMatch: true } })
    expect((await database().remarketingSale.findUniqueOrThrow({ where: { id: coi.body.id as string } })).screeningResult).toMatchObject({ matches: [{ kind: "COI_DECLARATION", on: "NAME" }] })
    expect(await propose(non, 60_000_000, { buyerName: "Unrelated Dealer", buyerIdentifier: "7777777777777" })).toMatchObject({ status: 201, body: { relatedPartyMatch: false } })
  }, 120_000)

  it("completes one sale per recovery: a second completion, a cancelled sale and a sale on a sold recovery are refused; the sale, its VAT event and its invoice are immutable", async () => {
    const rec = await plainListed(database(), fx, "NON_NCA", 50_000_000)
    officer()
    const first = (await propose(rec, 60_000_000)).body.id as string
    const second = (await propose(rec, 61_000_000, { buyerName: "TEST Second Buyer", buyerIdentifier: "6001015800083" })).body.id as string
    const cancelled = (await propose(rec, 62_000_000, { buyerName: "TEST Third Buyer", buyerIdentifier: "5001015800086" })).body.id as string
    expect((await readJson(await routes().cancelSale(rec.id, cancelled))).status).toBe(200)
    expect((await readJson(await routes().completeSale(rec.id, cancelled))).status).toBe(409)
    expect((await readJson(await routes().completeSale(rec.id, first, { completedOn: "2999-01-01" }))).status).toBe(409)
    expect((await readJson(await routes().completeSale(rec.id, first, { completedOn: "x" }))).status).toBe(409)
    expect((await readJson(await routes().completeSale(rec.id, first))).status).toBe(200)
    expect((await readJson(await routes().completeSale(rec.id, second))).status).toBe(409)
    expect((await readJson(await routes().completeSale(rec.id, first))).status).toBe(409)
    expect((await propose(rec, 60_000_000)).status).toBe(409)

    const sale = await database().remarketingSale.findUniqueOrThrow({ where: { id: first } })
    const [vat] = await database().recoveryVatEvent.findMany({ where: { recoveryId: rec.id } })
    await expect(database().remarketingSale.update({ where: { id: first }, data: { priceInclVatCents: 1 } })).rejects.toThrow(/immutable/)
    await expect(database().recoveryVatEvent.update({ where: { id: vat.id }, data: { inputTaxClaimCents: 1 } })).rejects.toThrow(/immutable/)
    await expect(database().taxInvoice.update({ where: { id: sale.taxInvoiceId as string }, data: { totalInclVatCents: 1 } })).rejects.toThrow()
    await expect(database().taxInvoice.delete({ where: { id: sale.taxInvoiceId as string } })).rejects.toThrow()
    expect(await database().remarketingSale.count({ where: { recoveryId: rec.id, status: "COMPLETED" } })).toBe(1)
  }, 120_000)

  it("answers a cross-tenant id with 404 and a READONLY session with 403 on every write", async () => {
    const rec = await plainListed(database(), fx, "NON_NCA", 50_000_000)
    officer()
    const sale = (await propose(rec, 60_000_000)).body.id as string
    const foreign = saleRoutes(other.host)
    as(other.admin, "LOAN_ADMIN", other.tenantId)
    for (const response of [
      await foreign.propose(rec.id, saleBody(rec.valuationId, 60_000_000)), await foreign.approveSale(rec.id, sale), await foreign.completeSale(rec.id, sale),
      await foreign.cancelSale(rec.id, sale), await foreign.proceeds(rec.id), await foreign.outcome(rec.id),
      await foreign.refund(rec.id, refundForm()), await foreign.approveRefund(rec.id), await foreign.releaseRefund(rec.id),
    ]) expect(response.status).toBe(404)

    as(fx.officer, "READONLY")
    for (const response of [
      await routes().propose(rec.id, saleBody(rec.valuationId, 60_000_000)), await routes().approveSale(rec.id, sale), await routes().completeSale(rec.id, sale),
      await routes().cancelSale(rec.id, sale), await routes().proceeds(rec.id), await routes().outcome(rec.id),
      await routes().refund(rec.id, refundForm()), await routes().approveRefund(rec.id), await routes().releaseRefund(rec.id),
    ]) expect(response.status).toBe(403)
    expect(await database().remarketingSale.findUniqueOrThrow({ where: { id: sale } })).toMatchObject({ status: "PENDING_APPROVAL" })
  }, 120_000)

  it("applies proceeds only to a sold recovery, as of now", async () => {
    const rec = await plainListed(database(), fx, "NON_NCA", 50_000_000)
    officer()
    expect((await readJson(await routes().proceeds(rec.id))).status).toBe(409) // LISTED
    expect((await readJson(await routes().outcome(rec.id))).status).toBe(409)
    expect((await readJson(await routes().refund(rec.id, refundForm()))).status).toBe(409) // no surplus held
    adminA()
    expect((await readJson(await routes().approveRefund(rec.id))).status).toBe(404)
    expect((await readJson(await routes().releaseRefund(rec.id))).status).toBe(404)
    officer()
    expect(await database().recoveryRefund.count({ where: { recoveryId: rec.id } })).toBe(0)
    const sale = (await propose(rec, 60_000_000)).body.id as string
    expect((await readJson(await routes().completeSale(rec.id, sale))).status).toBe(200)
    // Proceeds are applied as of now: a receipt date, back-dated or future, is refused.
    expect((await readJson(await routes().proceeds(rec.id, { receivedAt: new Date(Date.now() - 3 * 86_400_000).toISOString() }))).status).toBe(400)
    expect((await readJson(await routes().proceeds(rec.id, { receivedAt: new Date(Date.now() + 3 * 86_400_000).toISOString() }))).status).toBe(400)
    expect(await database().payment.count({ where: { loanId: rec.loan.loanId } })).toBe(0)
    // An undecided cost blocks the proceeds; a rejected one is not counted, an approved one is.
    const pending = await database().recoveryCost.create({ data: costData(fx, rec.id, { type: "TOWING", treatment: "DEDUCT_FROM_PROCEEDS", grossCents: 100_000 }) })
    expect(await readJson(await routes().proceeds(rec.id))).toMatchObject({ status: 409, body: { error: expect.stringMatching(/every cost is decided/) } })
    await database().recoveryCost.update({ where: { id: pending.id }, data: { status: "REJECTED", approvedById: fx.adminA, approvedAt: new Date() } })
    await recordDecidedCost(database(), fx, rec.id, { type: "STORAGE", treatment: "DEDUCT_FROM_PROCEEDS", grossCents: 250_000 })
    expect((await readJson(await routes().proceeds(rec.id))).status).toBe(200)
    expect(await database().recovery.findUniqueOrThrow({ where: { id: rec.id } })).toMatchObject({ deductedCostsCents: 250_000, netProceedsCents: 60_000_000 - 250_000 })
  }, 120_000)
})
