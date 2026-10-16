/**
 * Real-Postgres proof of the internal default cross-check (Fair Score audit
 * E5): a surety of a company has a loan with this lender in default; a new
 * lease for the company shows it on the deal page's credit memo, and approval
 * is refused (409, audited) until the approver gives a reason, which is then
 * stored with the exception on the decision and audited. The surety's loan is
 * a real booked operating lease, put in default directly. Only the session is
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
import { cleanupDealFixture, dealFixtureTenantId, dealRoutes } from "./deal.integration-fixture"
import { addMonthsClamped } from "./dates"
import { loadDealDetail } from "./deal-detail"
import { approveLease, cleanupLeaseRows, createLeaseFixture, leaseBody, payoutAndBook, signLease, type LeaseFixture } from "./lease.integration-fixture"
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
    const loan = await database().loan.update({
      where: { id: loanId }, data: { status: "DEFAULTED", daysInArrears: 166, arrearsAmount: 9_812_345 }, select: { reference: true },
    })
    suretyLoanReference = loan.reference
    await database().entityRelationship.create({ data: { tenantId: fx.tenantId, entityId: fx.evidenced, clientId: fx.lessee, role: "SURETY" } })
  }, 240_000)

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
    const approved = await dealRoutes(fx.host).decide(dealId, { decision: "APPROVE", reasons: REASONS, exceptionReason })
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
  })
})
