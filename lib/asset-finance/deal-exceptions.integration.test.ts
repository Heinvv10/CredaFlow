/**
 * Real-Postgres proof of the internal default cross-check (Fair Score audit
 * E5): a surety of a company has a loan with this lender in default; a new
 * lease for the company shows it on the deal page's credit memo, and approval
 * is refused (409, audited) until the approver gives a reason, which is then
 * stored with the exception on the decision and audited. The surety's loan is
 * a real booked operating lease, put in default directly. The reason answers
 * the exceptions the approver was shown: a stale set is refused. Only the session is
 * stubbed; routes, queries, triggers and CHECKs are real.
 *
 *   RUN_ASSET_FINANCE_LEASE_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/asset-finance/deal-exceptions.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { sastCalendarDate } from "@/lib/date/sast"
import { runWithTenant } from "@/lib/tenant-scope"
import { prisma } from "@/lib/prisma"
import { cleanupDealFixture, dealFixtureTenantId, dealRoutes } from "./deal.integration-fixture"
import { addMonthsClamped } from "./dates"
import { loadDealDetail } from "./deal-detail"
import { loadDealExceptions } from "./deal-exceptions"
import { dealCreditGate } from "./deal-credit-gate"
import { MAX_ARREARS_GROWTH_INSTALMENTS, regularInstalmentCents } from "./deal-exception-severity"
import {
  approveLease, cleanupLeaseRows, confirmChecklist, createAndApprovePayout, createLeaseFixture, leaseBody, payoutAndBook, signLease,
  type LeaseFixture,
} from "./lease.integration-fixture"
import { bookingRoutes } from "./payout-booking.integration-fixture"
import type { SessionUser } from "./payout-booking.integration-fixture"

const { session } = vi.hoisted(() => ({ session: { current: null as null | { user: SessionUser } } }))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => session.current) }))

const RUN = process.env.RUN_ASSET_FINANCE_LEASE_IT === "1"
const suite = RUN ? describe : describe.skip
const db = RUN ? new PrismaClient() : null
const t = randomUUID().replaceAll("-", "").slice(0, 16)
let fx: LeaseFixture
let dealId = ""
let suretyLoanReference = ""
let suretyLoanId = ""
let entityLoanId = ""

function database(): PrismaClient {
  if (!db) throw new Error("RUN_ASSET_FINANCE_LEASE_IT=1 is required")
  return db
}
const setSession = (user: SessionUser | null) => {
  session.current = user && { user }
}
const staff = (id: string, role: "LOAN_ADMIN" | "CREDIT_OFFICER") => setSession({ id, email: `${id}@lease-it.test`, role, tenantId: fx.tenantId })
const REASONS = ["Synthetic lessee cash flow covers the rental"]

suite.sequential("internal default cross-check on approval (real Postgres, real routes)", () => {
  beforeAll(async () => {
    process.env.TRUSTED_PROXY = "1"
    fx = await createLeaseFixture(database(), t)
    // The sole proprietor's own operating lease, booked, then in default; the same person stands surety for the company.
    const firstDue = addMonthsClamped(sastCalendarDate(new Date()), 1)
    const own = await approveLease(fx, staff, leaseBody(fx, {
      assetId: fx.assets[1], contractType: "OPERATING_LEASE", rentalTiming: "ADVANCE", clientId: fx.lessee, firstDueDate: firstDue,
    }))
    await signLease(fx, database(), setSession, own, firstDue)
    const loanId = await payoutAndBook(fx, database(), staff, own)
    // The company's own lease, booked and current (its arrears are set in the last test).
    const entityLease = await approveLease(fx, staff, leaseBody(fx, {
      assetId: fx.assets[2], contractType: "OPERATING_LEASE", rentalTiming: "ADVANCE", entityId: fx.evidenced, firstDueDate: firstDue,
    }))
    await signLease(fx, database(), setSession, entityLease, firstDue)
    entityLoanId = await payoutAndBook(fx, database(), staff, entityLease)
    const loan = await database().loan.update({
      where: { id: loanId }, data: { status: "DEFAULTED", daysInArrears: 166, arrearsAmount: 9_812_345 }, select: { reference: true },
    })
    suretyLoanReference = loan.reference
    suretyLoanId = loanId
    await database().entityRelationship.create({ data: { tenantId: fx.tenantId, entityId: fx.evidenced, clientId: fx.lessee, role: "SURETY" } })
  }, 360_000)

  afterAll(async () => {
    await cleanupLeaseRows(database(), dealFixtureTenantId(t)).catch(() => undefined)
    await cleanupDealFixture(database(), { tenantId: dealFixtureTenantId(t) })
    await db?.$disconnect()
  }, 60_000)

  it("shows the surety's defaulted loan on the company's new deal", async () => {
    const routes = dealRoutes(fx.host)
    staff(fx.officer, "CREDIT_OFFICER")
    const created = await routes.create(leaseBody(fx, { assetId: fx.assets[0], contractType: "FULL_MAINTENANCE_LEASE", rentalTiming: "ARREARS", entityId: fx.evidenced }))
    expect(created.status, await created.clone().text()).toBe(201)
    dealId = ((await created.json()) as { id: string }).id
    expect((await routes.submit(dealId)).status).toBe(200)
    expect((await routes.financials(dealId, {
      periodEnd: "2026-02-28", turnoverCents: 200_000_000, ebitdaCents: 60_000_000, totalAssetsCents: 200_000_000,
      totalLiabilitiesCents: 50_000_000, existingDebtServiceCents: 10_000_000, avgMonthlyCreditsCents: 16_000_000, returnedDebitsCount: 0,
    })).status).toBe(200)

    const page = await runWithTenant(fx.tenantId, () => loadDealDetail(fx.tenantId, dealId))
    expect(page?.exceptions.internalArrears).toEqual([expect.objectContaining({
      clientId: fx.lessee, roles: ["Surety"], reference: suretyLoanReference, status: "DEFAULTED", daysInArrears: 166, arrearsCents: 9_812_345,
    })])
    expect(page?.exceptions.lines).toEqual([
      `TEST Soleprop (Surety) has loan ${suretyLoanReference} with this lender: Defaulted, 166 days in arrears, R 98,123.45 overdue`,
    ])
  }, 60_000)

  it("refuses APPROVE without an exception reason (409, audited) and changes nothing", async () => {
    staff(fx.adminA, "LOAN_ADMIN")
    const refused = await dealRoutes(fx.host).decide(dealId, { decision: "APPROVE", reasons: REASONS })
    expect(refused.status).toBe(409)
    expect(((await refused.json()) as { error: string }).error).toContain(`has loan ${suretyLoanReference} with this lender: Defaulted, 166 days in arrears`)
    expect((await database().assetFinanceDeal.findUniqueOrThrow({ where: { id: dealId } })).status).toBe("SUBMITTED")
    const refusal = await database().auditLog.findFirst({ where: { entityId: dealId, action: "ASSET_DEAL_DECISION_REFUSED" }, orderBy: { createdAt: "desc" } })
    expect(JSON.stringify(refusal?.newValue)).toContain("exceptions_unanswered")
  })

  it("approves with the reason, storing and auditing the exception beside it", async () => {
    const exceptionReason = "The surety's lease is under a signed settlement and this asset secures the deal"
    staff(fx.adminA, "LOAN_ADMIN")
    const page = await runWithTenant(fx.tenantId, () => loadDealDetail(fx.tenantId, dealId))
    const stale = await dealRoutes(fx.host).decide(dealId, { decision: "APPROVE", reasons: REASONS, exceptionReason, exceptionsFingerprint: "0".repeat(64) })
    expect(stale.status).toBe(409)
    expect(((await stale.json()) as { error: string }).error).toMatch(/exceptions changed since the page was loaded/)
    const approved = await dealRoutes(fx.host).decide(dealId, { decision: "APPROVE", reasons: REASONS, exceptionReason, exceptionsFingerprint: page?.exceptions.fingerprint })
    expect(approved.status, await approved.clone().text()).toBe(200)
    const deal = await database().assetFinanceDeal.findUniqueOrThrow({ where: { id: dealId } })
    expect(deal.status).toBe("APPROVED")
    expect(deal.decisionReasons).toEqual([
      REASONS[0],
      expect.stringMatching(new RegExp(`^Exception: TEST Soleprop \\(Surety\\) has loan ${suretyLoanReference}`)),
      `Approved despite the exceptions: ${exceptionReason}`,
    ])
    const audit = await database().auditLog.findFirstOrThrow({ where: { entityId: dealId, action: "ASSET_DEAL_DECIDED" } })
    expect(audit.newValue).toMatchObject({ exceptionReason, exceptions: [expect.stringContaining(suretyLoanReference)] })
    // What the approval answered is fixed: payout and booking compare against it.
    expect(deal.approvalExceptions).toEqual([{ key: `ARREARS:${suretyLoanId}`, kind: "ARREARS", status: "DEFAULTED", daysInArrears: 166, arrearsCents: 9_812_345 }])
    await expect(database().assetFinanceDeal.update({ where: { id: dealId }, data: { approvalExceptions: [] } }))
      .rejects.toThrow(/recorded exceptions are the record of what its approval answered/)
  })

  it("payout and booking refuse the answered exception once its status or DPD band is worse; amount growth alone is only noted", async () => {
    const gate = () => runWithTenant(fx.tenantId, () => prisma.$transaction((tx) => dealCreditGate(tx, fx.tenantId, dealId)))
    const setLoan = (data: { status?: "DEFAULTED" | "WRITTEN_OFF"; daysInArrears?: number; arrearsAmount?: number }) =>
      database().loan.update({ where: { id: suretyLoanId }, data })
    expect(await gate()).toEqual({ problem: null, arrearsGrown: [] }) // as approved: DEFAULTED, 166 days, R98,123.45
    await setLoan({ daysInArrears: 200 })
    expect((await gate()).problem).toBeNull() // still in the 90+ band
    // The amount overdue rises at each missed due date: noted, not refused, up to 1.5 regular instalments.
    const rentals = await database().repaymentSchedule.findMany({ where: { loanId: suretyLoanId }, select: { totalDue: true } })
    const regular = regularInstalmentCents(rentals.map((r) => r.totalDue))
    expect(regular).toBeGreaterThan(0)
    await setLoan({ arrearsAmount: 9_900_000 })
    expect(await gate()).toEqual({
      problem: null,
      arrearsGrown: [{
        key: `ARREARS:${suretyLoanId}`, approvedArrearsCents: 9_812_345, currentArrearsCents: 9_900_000, approvedDaysInArrears: 166, currentDaysInArrears: 200,
        regularInstalmentCents: regular,
      }],
    })
    const cap = Math.floor(MAX_ARREARS_GROWTH_INSTALMENTS * regular)
    await setLoan({ arrearsAmount: 9_812_345 + cap })
    expect((await gate()).problem).toBeNull()
    await setLoan({ arrearsAmount: 9_812_345 + cap + 1 })
    expect((await gate()).problem?.message).toMatch(/its arrears grew by .*more than 1.5 regular instalments of/)
    await setLoan({ arrearsAmount: 9_900_000 })
    await setLoan({ status: "WRITTEN_OFF" })
    expect((await gate()).problem?.message).toMatch(/worse since approval: it moved from DEFAULTED to WRITTEN_OFF/)
    await setLoan({ status: "DEFAULTED" })
    expect((await gate()).problem).toBeNull()
  })

  it("the payout and the booking go ahead with the grown amount and record it in their audit rows", async () => {
    await signLease(fx, database(), setSession, dealId)
    await confirmChecklist(fx, database(), staff, dealId)
    await createAndApprovePayout(fx, database(), staff, dealId)
    const payout = await database().payout.findUniqueOrThrow({ where: { dealId } })
    const grown = [expect.objectContaining({ key: `ARREARS:${suretyLoanId}`, approvedArrearsCents: 9_812_345, currentArrearsCents: 9_900_000 })]
    const created = await database().auditLog.findFirstOrThrow({ where: { entityId: payout.id, action: "ASSET_PAYOUT_CREATED" } })
    expect(created.newValue).toMatchObject({ arrearsGrownSinceApproval: grown })
    staff(fx.adminA, "LOAN_ADMIN")
    const booked = await bookingRoutes(fx.host).book(dealId)
    expect(booked.status, await booked.clone().text()).toBe(201)
    const bookedAudit = await database().auditLog.findFirstOrThrow({ where: { entityId: dealId, action: "ASSET_DEAL_BOOKED" } })
    expect(bookedAudit.newValue).toMatchObject({ arrearsGrownSinceApproval: grown })
  }, 180_000)

  it("an instalment sale books with the grown amount in its booking audit too", async () => {
    const routes = dealRoutes(fx.host)
    staff(fx.officer, "CREDIT_OFFICER")
    const created = await routes.create({
      assetId: fx.assets[3], depositCents: 17_250_000, balloonCents: 0, firstDueDate: addMonthsClamped(sastCalendarDate(new Date()), 1),
      preset: { kind: "MONTHLY", periods: 36 }, rateBasis: "PRIME", rateMargin: "0.0100", entityId: fx.evidenced, supplierId: fx.supplier, productId: fx.product,
    })
    expect(created.status, await created.clone().text()).toBe(201)
    const sale = ((await created.json()) as { id: string }).id
    expect((await routes.submit(sale)).status).toBe(200)
    const row = await database().assetFinanceDeal.findUniqueOrThrow({ where: { id: sale } })
    const override = await database().ncaRegimeOverride.findFirstOrThrow({ where: { applicationId: row.applicationId } })
    staff(fx.adminB, "LOAN_ADMIN")
    expect((await routes.decideOverride(override.id, { decision: "APPROVE", note: "Synthetic AFS agree" })).status).toBe(200)
    staff(fx.officer, "CREDIT_OFFICER")
    expect((await routes.financials(sale, {
      periodEnd: "2026-02-28", turnoverCents: 200_000_000, ebitdaCents: 60_000_000, totalAssetsCents: 200_000_000,
      totalLiabilitiesCents: 50_000_000, existingDebtServiceCents: 10_000_000, avgMonthlyCreditsCents: 16_000_000, returnedDebitsCount: 0,
    })).status).toBe(200)
    const page = await runWithTenant(fx.tenantId, () => loadDealDetail(fx.tenantId, sale))
    staff(fx.adminA, "LOAN_ADMIN")
    const decided = await routes.decide(sale, {
      decision: "APPROVE", reasons: REASONS, exceptionReason: "The surety's lease is under a signed settlement plan", exceptionsFingerprint: page?.exceptions.fingerprint,
    })
    expect(decided.status, await decided.clone().text()).toBe(200)
    await signLease(fx, database(), setSession, sale)
    await confirmChecklist(fx, database(), staff, sale)
    await createAndApprovePayout(fx, database(), staff, sale)
    await database().loan.update({ where: { id: suretyLoanId }, data: { arrearsAmount: 9_950_000 } })
    staff(fx.adminA, "LOAN_ADMIN")
    const booked = await bookingRoutes(fx.host).book(sale)
    expect(booked.status, await booked.clone().text()).toBe(201)
    const audit = await database().auditLog.findFirstOrThrow({ where: { entityId: sale, action: "ASSET_DEAL_BOOKED" } })
    expect(audit.newValue).toMatchObject({
      interestModel: "REDUCING_BALANCE",
      arrearsGrownSinceApproval: [expect.objectContaining({ key: `ARREARS:${suretyLoanId}`, approvedArrearsCents: 9_900_000, currentArrearsCents: 9_950_000 })],
    })
  }, 240_000)

  it("cross-checks the borrower's own loans and a party's arrears, not only defaults", async () => {
    const exceptions = (deal: { entityId: string | null; clientId: string | null }) =>
      runWithTenant(fx.tenantId, () => loadDealExceptions(prisma, fx.tenantId, { applicationId: "none", ...deal }))
    const setLoan = (id: string, data: { status: "ACTIVE" | "RESTRUCTURED" | "DEFAULTED"; daysInArrears: number; arrearsAmount: number }) =>
      database().loan.update({ where: { id }, data })

    // A sole proprietor's own loan: ACTIVE in arrears, RESTRUCTURED with an amount overdue, ACTIVE and current.
    await setLoan(suretyLoanId, { status: "ACTIVE", daysInArrears: 12, arrearsAmount: 0 })
    expect((await exceptions({ entityId: null, clientId: fx.lessee })).internalArrears).toEqual([
      expect.objectContaining({ loanId: suretyLoanId, roles: ["Borrower"], status: "ACTIVE", daysInArrears: 12 }),
    ])
    await setLoan(suretyLoanId, { status: "RESTRUCTURED", daysInArrears: 0, arrearsAmount: 50_000 })
    expect((await exceptions({ entityId: null, clientId: fx.lessee })).keys).toEqual([`ARREARS:${suretyLoanId}`])
    await setLoan(suretyLoanId, { status: "ACTIVE", daysInArrears: 0, arrearsAmount: 0 })
    expect((await exceptions({ entityId: null, clientId: fx.lessee })).lines).toEqual([])

    // The entity's own loan in arrears.
    await setLoan(entityLoanId, { status: "ACTIVE", daysInArrears: 31, arrearsAmount: 1_000_000 })
    const company = await exceptions({ entityId: fx.evidenced, clientId: null })
    expect(company.internalArrears).toEqual([expect.objectContaining({ loanId: entityLoanId, clientId: null, roles: ["Borrower"], daysInArrears: 31 })])
    expect(company.lines[0]).toMatch(/\(Borrower\) has loan .* Active, 31 days in arrears, R\u00a010,000.00 overdue/)
    await setLoan(entityLoanId, { status: "ACTIVE", daysInArrears: 0, arrearsAmount: 0 })
  })
})
