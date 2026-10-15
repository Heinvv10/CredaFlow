/**
 * All eight independently worked acceptance recovery deals
 * (lib/asset-finance/__fixtures__/acceptance-recovery-deals.ts), two per route,
 * driven from a LISTED recovery through the real routes against a real migrated
 * Postgres to the same cents: the cost totals, net proceeds, the receipt, the
 * shortfall or surplus, the VAT event, the buyer's tax invoice split and the
 * outcome. Where a deal's debtor is a VAT vendor the loan's debtor is an entity
 * with a VAT number, behind an NCA loan too. (recovery-sale-proceeds.integration.test.ts
 * drives three of them further, through the surplus refund.) The legal and tax
 * rules are UNTESTED against the law.
 *
 *   RUN_ASSET_FINANCE_RECOVERY_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/asset-finance/recovery-gaps-deals.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { RECOVERY_DEALS } from "./__fixtures__/acceptance-recovery-deals"
import { listedGapDeal, VENDOR_VAT_NUMBER } from "./recovery-gaps.integration-fixture"
import { advance } from "./recovery-path.integration-fixture"
import { cleanupRecoveryFixture, createRecoveryFixture, recoveryFixtureTenantId, type RecoveryFixture } from "./recovery.integration-fixture"
import { readJson, saleBody, saleRoutes } from "./recovery-sale.integration-fixture"
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
const routes = () => saleRoutes(fx.host)

suite.sequential("every acceptance recovery deal, to the cent, through the real routes", () => {
  beforeAll(async () => {
    fx = await createRecoveryFixture(database(), t)
    await database().vatConfig.create({ data: { tenantId: fx.tenantId, vatNumber: "4000000001", registeredName: "TEST Asset Credit (Pty) Ltd", address: "1 Synthetic Road, Johannesburg, 2000" } })
  }, 120_000)

  afterAll(async () => {
    await cleanupRecoveryFixture(database(), recoveryFixtureTenantId(t)).catch(() => undefined)
    await db?.$disconnect()
  }, 60_000)

  it("works all eight deals", () => {
    expect(RECOVERY_DEALS.map((d) => d.id)).toEqual(["REC-S127-1", "REC-S127-2", "REC-S131-1", "REC-S131-2", "REC-NV-1", "REC-NV-2", "REC-NC-1", "REC-NC-2"])
  })

  for (const d of RECOVERY_DEALS) {
    it(`${d.id}: ${d.route} ${d.contractType}, debtor ${d.debtorVatVendor ? "a VAT vendor" : "not a VAT vendor"}`, async () => {
      const nca = d.route.startsWith("NCA")
      const recovery = await listedGapDeal(database(), fx, d)
      const as = (id: string, role: "CREDIT_OFFICER" | "LOAN_ADMIN") => { session.current = { user: { id, email: `${id}@recovery-it.test`, role, tenantId: fx.tenantId } } }
      as(fx.officer, "CREDIT_OFFICER")

      // the sale at the deal's gross proceeds, and the buyer's tax invoice split
      const proposed = await readJson(await routes().propose(recovery.id, saleBody(recovery.valuationId, d.grossProceedsCents)))
      expect(proposed).toMatchObject({ status: 201, body: { belowValuation: false, relatedPartyMatch: false, approvalRequired: false } })
      const completed = await readJson(await routes().completeSale(recovery.id, proposed.body.id as string))
      expect(completed.status).toBe(200)
      const invoice = await database().taxInvoice.findUniqueOrThrow({ where: { id: completed.body.taxInvoiceId as string }, include: { lines: true } })
      expect(invoice).toMatchObject({ loanId: null, totalInclVatCents: d.grossProceedsCents, totalExclVatCents: d.expected.resale.exclVatCents, vatCents: d.expected.resale.vatCents })
      expect(invoice.totalExclVatCents + invoice.vatCents).toBe(d.grossProceedsCents)

      // the VAT event
      const events = await database().recoveryVatEvent.findMany({ where: { recoveryId: recovery.id } })
      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({
        kind: d.expected.vat.kind, dealContractType: d.contractType, deemedSupplyValueCents: d.expected.vat.deemedSupplyValueCents,
        inputTaxClaimCents: d.expected.vat.inputTaxClaimCents, outputTaxCents: d.expected.vat.kind === "LESSOR_RESALE" ? d.expected.resale.vatCents : 0,
        debtorVatVendor: d.debtorVatVendor, debtorVatNumber: d.debtorVatVendor ? VENDOR_VAT_NUMBER : null, vatRateTenThousandths: 1500,
      })

      // the proceeds: costs, net, the receipt, the shortfall or surplus
      const proceeds = await readJson(await routes().proceeds(recovery.id))
      expect(proceeds).toMatchObject({ status: 200, body: { paymentCents: d.expected.paymentCents, shortfallCents: d.expected.shortfallCents, surplusCents: d.expected.surplusCents, replay: false } })
      const row = await database().recovery.findUniqueOrThrow({ where: { id: recovery.id } })
      expect(row).toMatchObject({
        status: "PROCEEDS_APPLIED", settlementDueCents: d.settlementDueCents, grossProceedsCents: d.grossProceedsCents, deductedCostsCents: d.expected.deductedCostsCents,
        chargedCostsCents: d.expected.chargedCostsCents, netProceedsCents: d.expected.netProceedsCents, shortfallCents: d.expected.shortfallCents, surplusCents: d.expected.surplusCents,
      })
      expect(row.netProceedsCents).toBe(d.grossProceedsCents - d.expected.deductedCostsCents)
      expect(d.expected.paymentCents).toBe(Math.min(d.expected.netProceedsCents, d.settlementDueCents))
      const payments = await database().payment.findMany({ where: { loanId: recovery.loan.loanId } })
      expect(payments).toHaveLength(1)
      expect(payments[0]).toMatchObject({ id: row.proceedsPaymentId, amount: d.expected.paymentCents, idempotencyKey: `asset-recovery:${recovery.id}:proceeds` })
      if (nca) expect(row.chargesFrozenUntil).toBeNull()
      else expect(((row.chargesFrozenUntil as Date).getTime() - (row.chargesFrozenFrom as Date).getTime()) / 86_400_000).toBe(10)
      if (d.route === "NCA_S127_SURRENDER") {
        expect(await database().surrenderRequest.findUniqueOrThrow({ where: { id: recovery.surrenderRequestId as string } })).toMatchObject({
          status: "PROCEEDS_CREDITED", saleProceedsCents: d.expected.paymentCents, proceedsPaymentId: row.proceedsPaymentId, shortfallCents: d.expected.shortfallCents, refundCents: d.expected.surplusCents,
        })
      }

      // the outcome (an NCA recovery's final notice fixes the freeze first)
      if (nca) await advance(database(), fx, recovery.loan, recovery.id, "FINAL_NOTICE_ISSUED", { surrenderId: recovery.surrenderRequestId ?? undefined })
      const outcome = await readJson(await routes().outcome(recovery.id))
      expect(outcome).toMatchObject({ status: 200, body: { status: d.expected.shortfallCents > 0 ? "SHORTFALL_OPEN" : "SURPLUS_HELD" } })
    }, 180_000)
  }
})
