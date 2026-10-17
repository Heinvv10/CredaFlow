/** Prepared for the approved migrated disposable database; synthetic only. */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { sastCalendarDate } from "@/lib/date/sast"
import { runWithTenant } from "@/lib/tenant-scope"
import { cleanupDealFixture, dealFixtureTenantId } from "./deal.integration-fixture"
import { approveLease, cleanupLeaseRows, createLeaseFixture, leaseBody, payoutAndBook, signLease, type LeaseFixture } from "./lease.integration-fixture"
import type { SessionUser } from "./payout-booking.integration-fixture"
import { createRecoveryTx } from "./recovery-create"
import { recordRecoveryValuation, listForSale } from "./recovery-store"
import { cleanupRecoveryRows } from "./recovery.integration-fixture"
import { recordDecidedCost } from "./recovery-path.integration-fixture"
import { readJson, saleBody, saleRoutes } from "./recovery-sale.integration-fixture"
import { applySaleProceeds } from "./recovery-proceeds"
import { CPA_CANCELLATION_FACTORS } from "./cpa-cancellation-assessment"
import { ruleRefuses } from "./lease-servicing.integration-fixture"
import { applyManualReceipt, type PaymentDb } from "@/lib/loan/apply-payment"
import { disableCharges } from "@/lib/loan/charges-switch"
import { backdateLease } from "./lease-servicing.integration-fixture"
import { dbDate, fromDayNumber, toDayNumber } from "./dates"
import { presentValueOfRentals } from "./lease-termination"
import { assessLessorCancellation } from "./lessor-cancellation-assessment"
import { loanSettlementFigures } from "@/lib/loan/charges-summary"
const { session } = vi.hoisted(() => ({ session: { current: null as null | { user: SessionUser } } }))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => session.current) }))
const RUN = process.env.RUN_ASSET_FINANCE_LEASE_IT === "1"
const db = RUN ? new PrismaClient() : null
const database = () => { if (!db) throw new Error("integration DB required"); return db }
const token = randomUUID().replaceAll("-", "").slice(0, 16)
let fx: LeaseFixture
const setSession = (user: SessionUser | null) => { session.current = user && { user } }
const staff = (id: string, role: "LOAN_ADMIN" | "CREDIT_OFFICER") => setSession({ id, role, email: `${id}@invalid.test`, tenantId: fx.tenantId })
;(RUN ? describe : describe.skip).sequential("CPA lessor reasoned net charge through actual recovery and sale", () => {
  beforeAll(async () => { process.env.TRUSTED_PROXY = "1"; fx = await createLeaseFixture(database(), token) }, 120_000)
  afterAll(async () => {
    vi.useRealTimers()
    await cleanupRecoveryRows(database(), dealFixtureTenantId(token)).catch(() => undefined)
    await cleanupLeaseRows(database(), dealFixtureTenantId(token)).catch(() => undefined)
    await cleanupDealFixture(database(), { tenantId: dealFixtureTenantId(token) })
    await db?.$disconnect()
  }, 60_000)
  for (const [index, assessedChargeCents, price] of [[0, 0, 20_000], [1, 5000, 20_000], [2, 0, 400_000_000], [3, -1, 20_000]]) {
    it(`records net charge ${assessedChargeCents}, real goods cash ${price}, and immutable actual costs without duplication`, async () => {
      const jointStop = index === 3
      const realToday = sastCalendarDate(new Date())
      if (jointStop) {
        await database().loanProduct.update({ where: { id: fx.product }, data: { nonNcaDefaultInterestMargin: "0.02", nonNcaCollectionFeeCents: 25_000 } })
        await database().tenantConfig.update({ where: { tenantId: fx.tenantId }, data: { defaultChargesEnabled: true, defaultChargesStartedAt: dbDate(fromDayNumber(toDayNumber(realToday) - 90)) } })
      }
      const dealId = await approveLease(fx, staff, leaseBody(fx, { assetId: fx.assets[index], clientId: fx.lessee, contractType: "OPERATING_LEASE", rentalTiming: "ARREARS" }))
      await signLease(fx, database(), setSession, dealId)
      const loanId = await payoutAndBook(fx, database(), staff, dealId)
      expect(await database().loan.findUniqueOrThrow({ where: { id: loanId } })).toMatchObject({ cpaApplies: true })
      const actor = { tenantId: fx.tenantId, userId: fx.adminA }
      const today = realToday
      let historicalRows: Awaited<ReturnType<PrismaClient["loanCharge"]["findMany"]>> = []
      let historicalPayment: Awaited<ReturnType<PrismaClient["payment"]["findUnique"]>> = null
      let arrearsBefore = 0
      if (jointStop) {
        await backdateLease(database(), loanId, 2)
        try {
          const paidOn = new Date(`${fromDayNumber(toDayNumber(today) - 20)}T12:00:00+02:00`)
          vi.useFakeTimers({ toFake: ["Date"], now: paidOn })
          const paid = await applyManualReceipt(database() as unknown as PaymentDb, { tenantId: fx.tenantId, loanId, amount: 50_000, capturedById: fx.adminA, reference: "SYN-HISTORIC-LIVE-CHARGES", receivedAt: paidOn })
          const stoppedAt = new Date(`${fromDayNumber(toDayNumber(today) - 10)}T12:00:00+02:00`)
          vi.setSystemTime(stoppedAt)
          await runWithTenant(fx.tenantId, () => disableCharges(database() as never, fx.tenantId, stoppedAt, { userId: fx.adminA, userEmail: "synthetic-admin@invalid.test" }))
          historicalPayment = await database().payment.findUniqueOrThrow({ where: { id: paid.payment.id } })
          expect(historicalPayment.defaultInterestAllocated + historicalPayment.chargeFeesAllocated).toBeGreaterThan(0)
          historicalRows = await database().loanCharge.findMany({ where: { loanId }, orderBy: { id: "asc" } })
        } finally { vi.useRealTimers() }
        const prior = await database().loan.findUniqueOrThrow({ where: { id: loanId }, include: { repaymentSchedule: true } })
        arrearsBefore = (await loanSettlementFigures(database() as never, prior, new Date())).arrearsIncludingCharges
      }
      const recovery = await database().$transaction((tx) => createRecoveryTx(tx as never, actor, { loanId, route: "NON_NCA_VOLUNTARY", recoveredOn: today, location: "Synthetic yard", condition: "Synthetic returned plant" }))
      if (recovery.kind !== "done") throw new Error(JSON.stringify(recovery))
      const tenant = <T>(run: () => Promise<T>) => runWithTenant(fx.tenantId, run)
      expect(await tenant(() => recordRecoveryValuation({ ...actor, userId: fx.officer }, recovery.id, { source: "ASSESSOR", valuedOn: today, valuerName: "Synthetic independent valuer", amountCents: price }))).toMatchObject({ kind: "done" })
      expect(await tenant(() => listForSale(actor, recovery.id))).toMatchObject({ kind: "done" })
      const valuation = await database().recovery.findUniqueOrThrow({ where: { id: recovery.id } })
      const actualCost = await recordDecidedCost(database(), fx, recovery.id, { type: "STORAGE", treatment: "CHARGE_TO_ACCOUNT", grossCents: 40_000 })
      staff(fx.adminA, "LOAN_ADMIN")
      const proposed = await readJson(await saleRoutes(fx.host).propose(recovery.id, saleBody(valuation.valuationId!, price, { belowValuationReason: "Synthetic forced sale supported by independent evidence" })))
      expect(proposed.status, JSON.stringify(proposed)).toBe(201)
      const saleId = proposed.body.id as string
      if (proposed.body.approvalRequired) {
        staff(fx.adminB, "LOAN_ADMIN")
        expect((await saleRoutes(fx.host).approveSale(recovery.id, saleId)).status).toBe(200)
      }
      staff(fx.adminA, "LOAN_ADMIN")
      expect((await saleRoutes(fx.host).completeSale(recovery.id, saleId)).status).toBe(200)
      expect(await tenant(() => applySaleProceeds(actor, recovery.id))).toMatchObject({ kind: "not_ready" })
      expect(await database().leaseTerminationQuote.count({ where: { loanId } })).toBe(0)
      await ruleRefuses(database(), { table: "LeaseTerminationQuote", trigger: "CpaLessorAssessment_guard" }, /cpa_lessor_assessment/, async (tx) => {
        const q = await tx.leaseTerminationQuote.create({ data: { tenantId: fx.tenantId, loanId, recoveryId: recovery.id, quotedOn: new Date(today), terminationDate: new Date(today), validUntil: new Date(today), lessorCancellation: true, cpaCancellation: false, remainingRentals: 0, pvCents: 0, penaltyCents: 0, arrearsCents: 0, invoiceExclVatCents: 0, invoiceVatCents: 0, totalCents: 0, basis: "Synthetic automatic unreasoned charge" } })
        await tx.leaseTerminationQuote.update({ where: { id: q.id }, data: { status: "ACCEPTED", acceptedAt: new Date(), acceptedById: fx.adminA } })
      })
      let approvedNet = assessedChargeCents
      if (jointStop) {
        const rows = await database().leaseRental.findMany({ where: { loanId, dueDate: { gt: dbDate(today) } } })
        const rates = await database().contractRate.findFirstOrThrow({ where: { loanId, effectiveDate: { lte: dbDate(today) } }, orderBy: { effectiveDate: "desc" } })
        const pv = presentValueOfRentals(rows.map((row) => ({ dueDate: row.dueDate.toISOString().slice(0, 10), rentalExclVatCents: row.rentalExclVatCents })), today, Number(rates.resultingRate))
        const floorFinding = { assessedChargeCents: 0, factors: Object.fromEntries(CPA_CANCELLATION_FACTORS.map(([key]) => [key, "Synthetic case finding"])), rationale: "Synthetic reduced charge", fairnessReason: "Synthetic proportionate breach claim" }
        approvedNet = assessLessorCancellation({ pvExclVatCents: pv, undiscountedRentalsCents: rows.reduce((sum, row) => sum + row.rentalExclVatCents, 0), netProceedsCents: price, chargedCosts: [{ id: actualCost.id, grossCents: actualCost.grossCents }], vatRateTenThousandths: 1500 }, floorFinding).ceilingCents - 5000
      }
      const assessment = { assessedChargeCents: approvedNet, factors: Object.fromEntries(CPA_CANCELLATION_FACTORS.map(([key]) => [key, "Synthetic case-specific finding supported by retained recovery evidence"])), rationale: "Replacement lessee available; reduce loss rather than automatically billing the ceiling", fairnessReason: "Proportionate to demonstrated loss; no unfair breach-cancellation charge" }
      staff(fx.officer, "CREDIT_OFFICER")
      expect((await saleRoutes(fx.host).proceeds(recovery.id, { assessment })).status).toBe(403)
      staff(fx.adminA, "LOAN_ADMIN")
      const applied = await tenant(() => applySaleProceeds(actor, recovery.id, assessment))
      expect(applied.kind, JSON.stringify(applied)).toBe("done")
      const quote = await database().leaseTerminationQuote.findUniqueOrThrow({ where: { recoveryId: recovery.id } })
      const recorded = quote.reasonableAssessment as { assessedChargeCents: number; chargedCostsCents: number; actualCostsCents: number; costConcessionCents: number; damagesInclVatCents: number }
      expect(recorded.assessedChargeCents).toBe(approvedNet)
      expect(recorded.actualCostsCents).toBe(40_000)
      expect(Math.max(0, recorded.damagesInclVatCents + recorded.chargedCostsCents - price)).toBe(approvedNet)
      expect(await database().recoveryCost.findUniqueOrThrow({ where: { id: actualCost.id } })).toEqual(actualCost)
      const loan = await database().loan.findUniqueOrThrow({ where: { id: loanId }, include: { repaymentSchedule: true } })
      expect((await loanSettlementFigures(database() as never, loan, new Date())).totalToSettle).toBe(approvedNet + arrearsBefore)
      const receipts = await database().payment.findMany({ where: { loanId, idempotencyKey: `asset-recovery:${recovery.id}:proceeds` } })
      expect(receipts).toHaveLength(1)
      expect(receipts[0].amount).toBe(Math.min(price, recorded.damagesInclVatCents + recorded.chargedCostsCents))
      expect(await tenant(() => applySaleProceeds(actor, recovery.id))).toMatchObject({ kind: "done", replay: true })
      expect(await database().payment.count({ where: { loanId } })).toBe(jointStop ? 2 : 1)
      if (jointStop) {
        expect(recorded.chargedCostsCents).toBeGreaterThan(0)
        const retained = await database().loanCharge.findMany({ where: { id: { in: historicalRows.map((row) => row.id) } }, orderBy: { id: "asc" } })
        expect(retained).toEqual(historicalRows)
        expect(await database().payment.findUniqueOrThrow({ where: { id: historicalPayment!.id } })).toEqual(historicalPayment)
        expect(await database().tenantConfig.findUniqueOrThrow({ where: { tenantId: fx.tenantId } })).toMatchObject({ defaultChargesEnabled: false })
      }
      await expect(database().leaseTerminationQuote.update({ where: { id: quote.id }, data: { reasonableAssessment: {} } })).rejects.toThrow(/final|accepted/i)
      if (price === 400_000_000) expect((await database().recovery.findUniqueOrThrow({ where: { id: recovery.id } })).surplusCents).toBe(price - recorded.damagesInclVatCents - recorded.chargedCostsCents)
    }, 120_000)
  }
})
