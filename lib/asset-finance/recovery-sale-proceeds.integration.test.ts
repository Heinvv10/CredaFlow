/**
 * Slice 4a remarketing sale, VAT event, proceeds and outcome through the real
 * routes against a real migrated Postgres. Three of the independently worked
 * acceptance deals (lib/asset-finance/__fixtures__/acceptance-recovery-deals.ts)
 * are driven from a LISTED recovery to the same cents: REC-S131-1 (an NCA
 * attachment to a shortfall), REC-NV-2 (a NON_NCA operating lease to a surplus,
 * refunded by two people) and REC-S127-2 (an s127 surrender to a surplus, which
 * moves the surrender to PROCEEDS_CREDITED). The loan of each is booked so its
 * settlement is exactly the deal's, so the shortfall, surplus and payment
 * asserted are the deal's own. The legal and tax rules are UNTESTED against the law.
 *
 *   RUN_ASSET_FINANCE_RECOVERY_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/asset-finance/recovery-sale-proceeds.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { RECOVERY_DEALS, type AcceptanceRecoveryDeal } from "./__fixtures__/acceptance-recovery-deals"
import { advance } from "./recovery-path.integration-fixture"
import { cleanupRecoveryFixture, createRecoveryFixture, recoveryFixtureTenantId, type RecoveryFixture } from "./recovery.integration-fixture"
import { listedDealRecovery, readJson, refundForm, saleBody, saleRoutes } from "./recovery-sale.integration-fixture"
import type { SessionUser } from "./payout-booking.integration-fixture"

const { session } = vi.hoisted(() => ({ session: { current: null as null | { user: SessionUser } } }))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => session.current) }))

const RUN = process.env.RUN_ASSET_FINANCE_RECOVERY_IT === "1"
const suite = RUN ? describe : describe.skip
const db = RUN ? new PrismaClient() : null
const t = randomUUID().replaceAll("-", "").slice(0, 16)
let fx: RecoveryFixture
const database = (): PrismaClient => {
  if (!db) throw new Error("RUN_ASSET_FINANCE_RECOVERY_IT=1 is required")
  return db
}
const as = (id: string, role: "CREDIT_OFFICER" | "LOAN_ADMIN") => { session.current = { user: { id, email: `${id}@recovery-it.test`, role, tenantId: fx.tenantId } } }
const officer = () => as(fx.officer, "CREDIT_OFFICER")
const adminA = () => as(fx.adminA, "LOAN_ADMIN")
const adminB = () => as(fx.adminB, "LOAN_ADMIN")
const routes = () => saleRoutes(fx.host)
const deal = (id: string): AcceptanceRecoveryDeal => RECOVERY_DEALS.find((d) => d.id === id) as AcceptanceRecoveryDeal

/** Propose and complete the deal's sale as an officer; the price is the deal's gross proceeds. */
async function sell(recovery: { id: string; valuationId: string }, d: AcceptanceRecoveryDeal) {
  officer()
  const proposed = await readJson(await routes().propose(recovery.id, saleBody(recovery.valuationId, d.grossProceedsCents)))
  expect(proposed).toMatchObject({ status: 201, body: { belowValuation: false, relatedPartyMatch: false, approvalRequired: false } })
  const completed = await readJson(await routes().completeSale(recovery.id, proposed.body.id as string))
  expect(completed.status).toBe(200)
  return { saleId: proposed.body.id as string, completed: completed.body }
}

suite.sequential("sale, VAT event, proceeds and outcome (real Postgres, real routes)", () => {
  beforeAll(async () => {
    fx = await createRecoveryFixture(database(), t)
    await database().vatConfig.create({ data: { tenantId: fx.tenantId, vatNumber: "4000000001", registeredName: "TEST Asset Credit (Pty) Ltd", address: "1 Synthetic Road, Johannesburg, 2000" } })
  }, 120_000)

  afterAll(async () => {
    await cleanupRecoveryFixture(database(), recoveryFixtureTenantId(t)).catch(() => undefined)
    await db?.$disconnect()
  }, 60_000)

  it("REC-S131-1: an NCA attachment sells, applies its proceeds to the deal's cents and opens the shortfall", async () => {
    const d = deal("REC-S131-1")
    const recovery = await listedDealRecovery(database(), fx, d, "NCA")
    const { saleId, completed } = await sell(recovery, d)

    const invoice = await database().taxInvoice.findUniqueOrThrow({ where: { id: completed.taxInvoiceId as string }, include: { lines: true } })
    expect(invoice).toMatchObject({ loanId: null, recipientName: "TEST Buyer", totalInclVatCents: d.grossProceedsCents, totalExclVatCents: d.expected.resale.exclVatCents, vatCents: d.expected.resale.vatCents })
    expect(invoice.lines).toHaveLength(1)
    expect(invoice.lines[0].description).toContain("TEST EX-R")
    expect(await database().remarketingSale.findUniqueOrThrow({ where: { id: saleId } })).toMatchObject({ status: "COMPLETED", taxInvoiceId: invoice.id })
    expect(await database().recovery.findUniqueOrThrow({ where: { id: recovery.id } })).toMatchObject({ status: "SOLD" })
    expect(await database().financedAsset.findUniqueOrThrow({ where: { id: recovery.loan.assetId } })).toMatchObject({ lessorStatus: "SOLD_IN_REMARKETING" })
    const [vat] = await database().recoveryVatEvent.findMany({ where: { recoveryId: recovery.id } })
    expect(vat).toMatchObject({
      kind: d.expected.vat.kind, deemedSupplyValueCents: d.expected.vat.deemedSupplyValueCents, inputTaxClaimCents: d.expected.vat.inputTaxClaimCents,
      outputTaxCents: 0, debtorVatVendor: false, dealContractType: "INSTALMENT_SALE", vatRateTenThousandths: 1500,
    })

    officer()
    const proceeds = await readJson(await routes().proceeds(recovery.id))
    expect(proceeds).toMatchObject({ status: 200, body: { paymentCents: d.expected.paymentCents, shortfallCents: d.expected.shortfallCents, surplusCents: d.expected.surplusCents, replay: false } })
    const row = await database().recovery.findUniqueOrThrow({ where: { id: recovery.id } })
    expect(row).toMatchObject({
      status: "PROCEEDS_APPLIED", settlementDueCents: d.settlementDueCents, grossProceedsCents: d.grossProceedsCents, deductedCostsCents: d.expected.deductedCostsCents,
      chargedCostsCents: d.expected.chargedCostsCents, netProceedsCents: d.expected.netProceedsCents, shortfallCents: d.expected.shortfallCents, surplusCents: 0, chargesFrozenUntil: null,
    })
    expect(row.chargesFrozenFrom).not.toBeNull()
    const payments = await database().payment.findMany({ where: { loanId: recovery.loan.loanId } })
    expect(payments).toHaveLength(1)
    expect(payments[0]).toMatchObject({ id: row.proceedsPaymentId, amount: d.expected.paymentCents, reference: `REC-${recovery.id}`, idempotencyKey: `asset-recovery:${recovery.id}:proceeds` })

    // Repeating the call answers with the recorded result and writes no second receipt.
    const again = await readJson(await routes().proceeds(recovery.id))
    expect(again).toMatchObject({ status: 200, body: { replay: true, paymentId: row.proceedsPaymentId, shortfallCents: d.expected.shortfallCents } })
    expect(await database().payment.count({ where: { loanId: recovery.loan.loanId } })).toBe(1)

    // The outcome opens only once the final notice has fixed the freeze (the notice itself is the notice routes' job).
    expect((await readJson(await routes().outcome(recovery.id))).status).toBe(409)
    await advance(database(), fx, recovery.loan, recovery.id, "FINAL_NOTICE_ISSUED")
    const outcome = await readJson(await routes().outcome(recovery.id))
    expect(outcome).toMatchObject({ status: 200, body: { status: "SHORTFALL_OPEN" } })
    // Never a write-off: the loan is still collectible and its collections stage was not touched.
    expect(await database().loan.findUniqueOrThrow({ where: { id: recovery.loan.loanId } })).toMatchObject({ status: "ACTIVE", totalPaid: d.expected.paymentCents, collectionsStage: "NONE" })
  }, 180_000)

  it("REC-NV-2: a NON_NCA operating-lease recovery records the lessor's resale VAT, freezes charges for the demand period and refunds its surplus through two people", async () => {
    const d = deal("REC-NV-2")
    const recovery = await listedDealRecovery(database(), fx, d, "NON_NCA")
    const { completed } = await sell(recovery, d)
    const invoice = await database().taxInvoice.findUniqueOrThrow({ where: { id: completed.taxInvoiceId as string } })
    expect(invoice).toMatchObject({ totalExclVatCents: d.expected.resale.exclVatCents, vatCents: d.expected.resale.vatCents })
    const [vat] = await database().recoveryVatEvent.findMany({ where: { recoveryId: recovery.id } })
    expect(vat).toMatchObject({
      kind: "LESSOR_RESALE", deemedSupplyValueCents: 0, inputTaxClaimCents: 0, outputTaxCents: d.expected.resale.vatCents,
      debtorVatVendor: true, debtorVatNumber: "4000000099", dealContractType: "OPERATING_LEASE",
    })

    officer()
    expect(await readJson(await routes().proceeds(recovery.id))).toMatchObject({ status: 200, body: { paymentCents: d.expected.paymentCents, shortfallCents: 0, surplusCents: d.expected.surplusCents } })
    const row = await database().recovery.findUniqueOrThrow({ where: { id: recovery.id } })
    expect(row).toMatchObject({ status: "PROCEEDS_APPLIED", netProceedsCents: d.expected.netProceedsCents, deductedCostsCents: d.expected.deductedCostsCents, surplusCents: d.expected.surplusCents })
    // A NON_NCA freeze is the demand period (default 10 days) from the proceeds date, fixed with the proceeds.
    const days = (row.chargesFrozenUntil as Date).getTime() - (row.chargesFrozenFrom as Date).getTime()
    expect(days / 86_400_000).toBe(10)
    expect((await database().loan.findUniqueOrThrow({ where: { id: recovery.loan.loanId } })).status).toBe("COMPLETED")

    expect(await readJson(await routes().outcome(recovery.id))).toMatchObject({ status: 200, body: { status: "SURPLUS_HELD" } })

    // The surplus refund: created by one LOAN_ADMIN, never approved by the same one, released by a LOAN_ADMIN, which closes the recovery.
    adminA()
    const created = await readJson(await routes().refund(recovery.id, refundForm()))
    expect(created).toMatchObject({ status: 201, body: { amountCents: d.expected.surplusCents } })
    expect(JSON.stringify(created.body)).not.toContain("62000000001")
    expect(await readJson(await routes().approveRefund(recovery.id))).toMatchObject({ status: 409 })
    expect(await readJson(await routes().releaseRefund(recovery.id))).toMatchObject({ status: 409 })
    adminB()
    expect((await readJson(await routes().approveRefund(recovery.id))).status).toBe(200)
    adminA()
    expect(await readJson(await routes().releaseRefund(recovery.id))).toMatchObject({ status: 200 })
    expect(await database().recovery.findUniqueOrThrow({ where: { id: recovery.id } })).toMatchObject({ status: "CLOSED" })
    expect(await database().recoveryRefund.findUniqueOrThrow({ where: { recoveryId: recovery.id } })).toMatchObject({ status: "RELEASED", releasedById: fx.adminA, approvedById: fx.adminB })
    const audited = await database().auditLog.findMany({ where: { tenantId: fx.tenantId, entityId: { in: [recovery.id] } }, select: { newValue: true } })
    expect(JSON.stringify(audited)).not.toContain("62000000001")
  }, 180_000)

  it("REC-S127-2: an s127 surrender is credited with the exact receipt and the surplus is held", async () => {
    const d = deal("REC-S127-2")
    const recovery = await listedDealRecovery(database(), fx, d, "NCA")
    await sell(recovery, d)
    officer()
    expect(await readJson(await routes().proceeds(recovery.id))).toMatchObject({ status: 200, body: { paymentCents: d.expected.paymentCents, surplusCents: d.expected.surplusCents, shortfallCents: 0 } })
    const rec = await database().recovery.findUniqueOrThrow({ where: { id: recovery.id } })
    // The surrender's receipt check wants the receipt itself (the settlement), not the gross sale price.
    expect(await database().surrenderRequest.findUniqueOrThrow({ where: { id: rec.surrenderRequestId as string } })).toMatchObject({
      status: "PROCEEDS_CREDITED", saleProceedsCents: d.expected.paymentCents, proceedsPaymentId: rec.proceedsPaymentId, shortfallCents: 0, refundCents: d.expected.surplusCents,
    })
    await advance(database(), fx, recovery.loan, recovery.id, "FINAL_NOTICE_ISSUED", { surrenderId: rec.surrenderRequestId as string })
    expect(await readJson(await routes().outcome(recovery.id))).toMatchObject({ status: 200, body: { status: "SURPLUS_HELD" } })
  }, 180_000)
})
