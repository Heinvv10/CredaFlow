/** Legal gaps 13, 14 and 25, through the real migrated ledger and tax-invoice service. Synthetic only. */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { sastCalendarDate } from "@/lib/date/sast"
import { cleanupDealFixture, dealFixtureTenantId } from "./deal.integration-fixture"
import { approveLease, cleanupLeaseRows, createLeaseFixture, leaseBody, payoutAndBook, signLease, type LeaseFixture } from "./lease.integration-fixture"
import { applyManualReceipt, type PaymentDb } from "@/lib/loan/apply-payment"
import { backdateLease, testSetup, ruleRefuses } from "./lease-servicing.integration-fixture"
import type { SessionUser } from "./payout-booking.integration-fixture"
import { quoteEarlyTermination, acceptEarlyTermination } from "./lease-termination-store"
import { fundBalance } from "./maintenance-fund"
import { prepareLeaseRecoveryDamages } from "./lease-recovery-damages"
import { recordLeaseTotalLoss } from "./lease-total-loss"
import { issueLeaseRentalInvoice } from "./lease-invoices"
import { CPA_CANCELLATION_FACTORS } from "./cpa-cancellation-assessment"
import { vatOnExclusive } from "@/lib/vat/amounts"

const { session } = vi.hoisted(() => ({ session: { current: null as null | { user: SessionUser } } }))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => session.current) }))
const RUN = process.env.RUN_ASSET_FINANCE_LEASE_IT === "1"
const db = RUN ? new PrismaClient() : null
const database = () => { if (!db) throw new Error("RUN_ASSET_FINANCE_LEASE_IT required"); return db }
const suite = RUN ? describe : describe.skip
const t = randomUUID().replaceAll("-", "").slice(0, 16)
let fx: LeaseFixture
const loans: string[] = []
const today = () => sastCalendarDate(new Date())
const setSession = (user: SessionUser | null) => { session.current = user && { user } }
const staff = (id: string, role: "LOAN_ADMIN" | "CREDIT_OFFICER") => setSession({ id, email: `${id}@lease-it.test`, role, tenantId: fx.tenantId })
suite.sequential("lease legal calculations applied to actual accounts", () => {
  beforeAll(async () => {
    process.env.TRUSTED_PROXY = "1"
    fx = await createLeaseFixture(database(), t)
    for (const assetId of fx.assets.slice(0, 4)) {
      const id = await approveLease(fx, staff, leaseBody(fx, { assetId, contractType: "OPERATING_LEASE", rentalTiming: "ARREARS", ...(assetId === fx.assets[3] ? { clientId: fx.lessee } : { entityId: fx.evidenced }) }))
      await signLease(fx, database(), setSession, id)
      loans.push(await payoutAndBook(fx, database(), staff, id))
    }
    const source = await database().financedAsset.findUniqueOrThrow({ where: { id: fx.assets[3] } })
    for (const label of ["PREPAID", "RECOVERY"]) {
      const asset = await database().financedAsset.create({ data: { ...source, id: undefined, serialNumber: `SYN-${label}-${t}`, vin: null, registrationNumber: null, lessorStatus: null, releasedAt: null } })
      const deal = await approveLease(fx, staff, leaseBody(fx, { assetId: asset.id, contractType: label === "PREPAID" ? "FULL_MAINTENANCE_LEASE" : "OPERATING_LEASE", rentalTiming: "ARREARS", ...(label === "PREPAID" ? { clientId: fx.lessee, maintenanceRiskModel: "LESSEE_SETTLED" } : { entityId: fx.evidenced }) }))
      await signLease(fx, database(), setSession, deal)
      loans.push(await payoutAndBook(fx, database(), staff, deal))
    }

  }, 600_000)
  afterAll(async () => {
    await cleanupLeaseRows(database(), dealFixtureTenantId(t)).catch(() => undefined)
    await cleanupDealFixture(database(), { tenantId: dealFixtureTenantId(t) })
    await db?.$disconnect()
  }, 60_000)
  it("commercial termination date and PV are recalculated on acceptance", async () => {
    const actor = { tenantId: fx.tenantId, userId: fx.adminA }
    const quoted = await database().$transaction((tx) => quoteEarlyTermination(tx as never, actor, { loanId: loans[0], today: today() }))
    expect(quoted.kind).toBe("quoted")
    if (quoted.kind !== "quoted") return
    const before = await database().leaseTerminationQuote.findUniqueOrThrow({ where: { id: quoted.quoteId } })
    await testSetup(database(), ['UPDATE "LeaseTerminationQuote" SET "quotedOn" = "quotedOn" - 1, "terminationDate" = "terminationDate" - 1 WHERE "id" = $1', quoted.quoteId])
    const result = await database().$transaction((tx) => acceptEarlyTermination(tx as never, actor, { quoteId: quoted.quoteId, today: today() }))
    expect(result.kind).toBe("accepted")
    const after = await database().leaseTerminationQuote.findUniqueOrThrow({ where: { id: quoted.quoteId } })
    expect(sastCalendarDate(after.terminationDate)).toBe(today())
    expect(after.pvCents).toBe(before.pvCents)
  })
  it("a write-off cancels future rentals and records insurer cash once, without a penalty", async () => {
    const result = await database().$transaction((tx) => recordLeaseTotalLoss(tx as never, { tenantId: fx.tenantId, userId: fx.adminA }, { loanId: loans[1], today: today(), insuranceProceedsCents: 10_000_000, evidence: "synthetic-insurer-payment-and-writeoff.pdf" }))
    expect(result.kind).toBe("recorded")
    const quote = await database().leaseTerminationQuote.findFirstOrThrow({ where: { loanId: loans[1] } })
    expect(quote).toMatchObject({ totalLoss: true, penaltyCents: 0, insuranceProceedsCents: 10_000_000 })
    expect(await database().leaseRental.count({ where: { loanId: loans[1], cancelledAt: null } })).toBe(0)
    const schedule = await database().repaymentSchedule.findMany({ where: { loanId: loans[1] } })
    expect(schedule.reduce((sum, row) => sum + row.totalDue - row.totalPaid, 0)).toBe(quote.pvCents - 10_000_000)
    expect(await database().payment.count({ where: { loanId: loans[1] } })).toBe(1)
  })
  it("uses supply-date VAT when the booked rate differs, keeping invoice, rental, schedule and loan totals equal", async () => {
    const id = loans[2]
    await backdateLease(database(), id, 1)
    const rental = await database().leaseRental.findFirstOrThrow({ where: { loanId: id }, orderBy: { periodNo: "asc" } })
    const fakeVat = vatOnExclusive(rental.rentalExclVatCents, 1400)
    const fakeTotal = rental.rentalExclVatCents + fakeVat
    const delta = fakeTotal - rental.totalCents
    await testSetup(database(),
      ['UPDATE "LeaseRental" SET "vatRate" = 0.14, "vatCents" = $2, "totalCents" = $3 WHERE "id" = $1', rental.id, fakeVat, fakeTotal],
      ['UPDATE "RepaymentSchedule" SET "principalDue" = $2, "totalDue" = $2 WHERE "id" = $1', rental.scheduleId, fakeTotal],
      ['UPDATE "Loan" SET "principal" = "principal" + $2, "totalRepayable" = "totalRepayable" + $2, "outstandingPrincipal" = "outstandingPrincipal" + $2 WHERE "id" = $1', id, delta])
    const result = await database().$transaction((tx) => issueLeaseRentalInvoice(tx as never, { tenantId: fx.tenantId, rentalId: rental.id, supplyDate: today(), today: today(), createdById: fx.adminA, source: "staff" }))
    expect(result.kind).toBe("issued")
    const updated = await database().leaseRental.findUniqueOrThrow({ where: { id: rental.id }, include: { schedule: true, taxInvoice: true } })
    expect(Number(updated.vatRate)).toBe(0.15)
    expect(updated.totalCents).toBe(rental.totalCents)
    expect(updated.schedule.totalDue).toBe(updated.taxInvoice?.totalInclVatCents)
  })
  it("CPA lessor damages replace undiscounted rentals, carry no percentage penalty, and cap the charge after actual costs and net proceeds", async () => {
    const loanId = loans[3]
    const before = await database().loan.findUniqueOrThrow({ where: { id: loanId } })
    const undiscounted = (await database().leaseRental.findMany({ where: { loanId } })).reduce((sum, r) => sum + r.rentalExclVatCents, 0)
    const chargedCostsCents = 20_000_000
    const netProceedsCents = 1_000_000
    await database().$transaction((tx) => prepareLeaseRecoveryDamages(tx as never, { tenantId: fx.tenantId, userId: fx.adminA, loanId, recoveredOn: today(), today: today(), netProceedsCents, chargedCostsCents }))
    const quote = await database().leaseTerminationQuote.findFirstOrThrow({ where: { loanId } })
    const after = await database().loan.findUniqueOrThrow({ where: { id: loanId } })
    expect(quote.lessorCancellation).toBe(true)
    expect(quote.penaltyCents).toBe(0)
    expect(after.totalRepayable).toBeLessThan(before.totalRepayable)
    expect(quote.totalCents + chargedCostsCents - netProceedsCents).toBeLessThan(undiscounted)
    expect(await database().leaseRental.count({ where: { loanId, cancelledAt: null } })).toBe(0)
  })

  it("a fully prepaid CPA lease can be cancelled: future invoices are credited, cash conserved, and excess is held as a refund credit", async () => {
    const loanId = loans[4]
    const before = await database().loan.findUniqueOrThrow({ where: { id: loanId } })
    await applyManualReceipt(database() as unknown as PaymentDb, { tenantId: fx.tenantId, loanId, amount: before.totalRepayable, capturedById: fx.adminA, reference: "SYNTHETIC-PREPAID" })
    expect((await database().loan.findUniqueOrThrow({ where: { id: loanId } })).status).toBe("COMPLETED")
    const contribution = await database().maintenanceFundMovement.findFirstOrThrow({ where: { tenantId: fx.tenantId, fund: { loanId }, kind: "CONTRIBUTION" } })
    await ruleRefuses(database(), { fn: "guardMaintenanceFundMovement", replace: ['AND r."cancelledAt" IS NOT NULL AND r."cancellationCreditNoteId" IS NOT NULL', ""] }, /must be backed/, (tx) => tx.maintenanceFundMovement.create({ data: {
      tenantId: fx.tenantId, fundId: contribution.fundId, kind: "CONTRIBUTION_CREDIT", amountCents: contribution.amountCents,
      creditedLeaseRentalId: contribution.leaseRentalId, occurredOn: new Date(`${today()}T00:00:00Z`), createdById: fx.adminA,
    } }))
    const quote = await database().$transaction(async (tx) => {
      const result = await quoteEarlyTermination(tx as never, { tenantId: fx.tenantId, userId: fx.adminA }, { loanId, today: today() })
      await tx.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE")
      return result
    })
    expect(quote.kind).toBe("quoted")
    const rentals = await database().leaseRental.findMany({ where: { loanId }, include: { schedule: true } })
    expect(rentals.every((r) => r.cancelledAt && r.schedule.totalDue === 0 && r.schedule.totalPaid === 0)).toBe(true)
    expect(await database().creditNote.count({ where: { tenantId: fx.tenantId, invoice: { loanId } } })).toBe(rentals.length)
    expect(fundBalance(await database().maintenanceFundMovement.findMany({ where: { fund: { loanId } } }))).toBe(0)
    const payments = await database().payment.findMany({ where: { loanId, reversed: false } })
    expect(payments.reduce((sum, p) => sum + p.amount, 0)).toBe(before.totalRepayable)
    expect(payments.filter((p) => p.allocationStatus === "UNAPPLIED").reduce((sum, p) => sum + p.amount, 0)).toBe(before.totalRepayable)
    if (quote.kind !== "quoted") return
    const rejected = await database().$transaction((tx) => acceptEarlyTermination(tx as never, { tenantId: fx.tenantId, userId: fx.adminA }, { quoteId: quote.quoteId, today: today(), assessment: { goodsValueCents: 50_000_000, costs: [{ description: "Recovery already netted", amountCents: 10_000, evidence: "synthetic-cost.pdf" }] } }))
    expect(rejected).toMatchObject({ kind: "refused", reason: "invalid_assessment" })
    await expect(database().leaseTerminationQuote.update({ where: { id: quote.quoteId }, data: { status: "ACCEPTED", acceptedAt: new Date(), acceptedById: fx.adminA, documentedCosts: [{ description: "Recovery already netted", amountCents: 10_000, evidence: "synthetic-cost.pdf" }], reasonableAssessment: { assessedChargeCents: 0, ceilingCents: 0, factors: Object.fromEntries(CPA_CANCELLATION_FACTORS.map(([key]) => [key, "Synthetic case considered"])), rationale: "No actual net loss", cancellationRightReason: "Zero charge preserves cancellation" }, goodsValueCents: 2_000_000_000 } })).rejects.toThrow(/cost_overlap_evidence/)
    await ruleRefuses(database(), { fn: "guardCpaReasonableAssessment", replace: ['IF NEW."status" <>', 'IF TRUE OR NEW."status" <>'] }, /cpa_reasonable_assessment/, (tx) => tx.leaseTerminationQuote.update({ where: { id: quote.quoteId }, data: { status: "ACCEPTED", acceptedAt: new Date(), acceptedById: fx.adminA } }))
    const missingFactors = await database().$transaction((tx) => acceptEarlyTermination(tx as never, { tenantId: fx.tenantId, userId: fx.adminA }, { quoteId: quote.quoteId, today: today(), assessment: { goodsValueCents: 0, costs: [] } }))
    expect(missingFactors).toMatchObject({ kind: "refused", reason: "reasonable_assessment" })
    const reasonableAssessment = { assessedChargeCents: 500, factors: Object.fromEntries(CPA_CANCELLATION_FACTORS.map(([key]) => [key, "Synthetic actual facts considered; see synthetic valuation record"])), rationale: "Replacement lessee identified, reduce the calculated ceiling to actual remaining loss", cancellationRightReason: "Reduced charge leaves the consumer able to exercise cancellation" }
    const excessive = await database().$transaction((tx) => acceptEarlyTermination(tx as never, { tenantId: fx.tenantId, userId: fx.adminA }, { quoteId: quote.quoteId, today: today(), assessment: { goodsValueCents: 0, costs: [], reasonableAssessment: { ...reasonableAssessment, assessedChargeCents: before.totalRepayable + 1 } } }))
    expect(excessive).toMatchObject({ kind: "refused", reason: "reasonable_assessment" })
    const assessed = await database().$transaction(async (tx) => {
      const result = await acceptEarlyTermination(tx as never, { tenantId: fx.tenantId, userId: fx.adminA }, { quoteId: quote.quoteId, today: today(), assessment: { goodsValueCents: 0, costs: [], reasonableAssessment } })
      await tx.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE")
      return result
    })
    expect(assessed.kind).toBe("accepted")
    const priced = await database().leaseTerminationQuote.findUniqueOrThrow({ where: { id: quote.quoteId } })
    await expect(database().leaseTerminationQuote.update({ where: { id: quote.quoteId }, data: { reasonableAssessment: { ...reasonableAssessment, assessedChargeCents: 0 } } })).rejects.toThrow()
    expect(priced.invoiceExclVatCents).toBe(500)
    expect(priced.reasonableAssessment).toMatchObject({ assessedChargeCents: 500, rationale: reasonableAssessment.rationale })
    const after = await database().payment.findMany({ where: { loanId, reversed: false } })
    expect(after.reduce((sum, p) => sum + p.amount, 0)).toBe(before.totalRepayable)
    expect(after.filter((p) => p.allocationStatus === "UNAPPLIED").reduce((sum, p) => sum + p.amount, 0)).toBe(before.totalRepayable - priced.totalCents)
    expect((await database().repaymentSchedule.findUniqueOrThrow({ where: { id: priced.scheduleId! } })).totalPaid).toBe(priced.totalCents)
  })

  it("lessor cancellation credits already-invoiced future rentals and carries prepaid cash onto discounted damages exactly once", async () => {
    const loanId = loans[5]
    const rentals = await database().leaseRental.findMany({ where: { loanId }, orderBy: { periodNo: "asc" } })
    const prepaid = rentals[0].totalCents + rentals[1].totalCents
    await applyManualReceipt(database() as unknown as PaymentDb, { tenantId: fx.tenantId, loanId, amount: prepaid, capturedById: fx.adminA, reference: "SYNTHETIC-PREPAID-RECOVERY" })
    expect(await database().leaseRental.count({ where: { loanId, taxInvoiceId: { not: null } } })).toBe(2)
    await database().$transaction(async (tx) => {
      await prepareLeaseRecoveryDamages(tx as never, { tenantId: fx.tenantId, userId: fx.adminA, loanId, recoveredOn: today(), today: today(), netProceedsCents: 0, chargedCostsCents: 0 })
      await tx.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE")
    })
    const quote = await database().leaseTerminationQuote.findFirstOrThrow({ where: { loanId } })
    expect(await database().creditNote.count({ where: { tenantId: fx.tenantId, invoice: { loanId } } })).toBe(2)
    expect((await database().payment.findMany({ where: { loanId, reversed: false } })).reduce((sum, p) => sum + p.amount, 0)).toBe(prepaid)
    const schedule = await database().repaymentSchedule.findMany({ where: { loanId } })
    expect(schedule.reduce((sum, r) => sum + r.totalDue - r.totalPaid, 0)).toBe(quote.totalCents - prepaid)
  })

})
