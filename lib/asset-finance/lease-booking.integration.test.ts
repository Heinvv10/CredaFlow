/**
 * Real-Postgres proof of slice 3 C1–C3: an operating or full-maintenance lease
 * is accepted for an entity and for a sole proprietor (Client), written
 * NON_NCA / LEASE_NOT_CREDIT_AGREEMENT with its CPA scope, signed, contracted,
 * paid out and booked through the real routes to a Loan whose schedule rows
 * are the VAT-inclusive rentals, with a LeaseRental per row and no inception
 * tax invoice. The staff loan figures, arrears and settlement read the
 * rentals. Only the session is stubbed; routes, pricing, triggers and CHECKs
 * are real.
 *
 *   RUN_ASSET_FINANCE_LEASE_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/asset-finance/lease-booking.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { sastCalendarDate } from "@/lib/date/sast"
import { staffLoanFigures } from "@/lib/loan/loan-page-figures"
import { dealFixtureTenantId, cleanupDealFixture } from "./deal.integration-fixture"
import { addMonthsClamped, isoOfDbDate } from "./dates"
import { approveLease, cleanupLeaseRows, createLeaseFixture, leaseBody, payoutAndBook, signLease, type LeaseFixture } from "./lease.integration-fixture"
import type { SessionUser } from "./payout-booking.integration-fixture"
import { signingRoutes } from "./deal-signing.integration-fixture"
import { CONSUMER_BORROWER_WHERE } from "@/lib/bureau-submission/population"
import { pdfPageContents } from "@/lib/pdf/__tests__/pdf-test-utils"
import { renderEntityStatementPdf } from "./documents/statement-pdf"
import { renderLeaseStatementPdf } from "./documents/lease/statement-pdf"
import { loadPortalContract } from "./portal-contract"
import { runWithTenant } from "@/lib/tenant-scope"

const pdfText = async (bytes: Buffer) => (await pdfPageContents(bytes))
  .flatMap((content) => [...content.matchAll(/<([0-9A-Fa-f]+)> Tj/g)].map((m) => Buffer.from(m[1], "hex").toString("latin1"))).join("\n")

const { session } = vi.hoisted(() => ({ session: { current: null as null | { user: SessionUser } } }))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => session.current) }))

const RUN = process.env.RUN_ASSET_FINANCE_LEASE_IT === "1"
const suite = RUN ? describe : describe.skip
const db = RUN ? new PrismaClient() : null
const t = randomUUID().replaceAll("-", "").slice(0, 16)
let fx: LeaseFixture
let fmlDeal = ""
let fmlLoan = ""
let olDeal = ""
let olLoan = ""

function database(): PrismaClient {
  if (!db) throw new Error("RUN_ASSET_FINANCE_LEASE_IT=1 is required")
  return db
}
const setSession = (user: SessionUser | null) => {
  session.current = user && { user }
}
const staff = (id: string, role: "LOAN_ADMIN" | "CREDIT_OFFICER") => setSession({ id, email: `${id}@lease-it.test`, role, tenantId: fx.tenantId })

suite.sequential("operating and full-maintenance leases: origination to booking (real Postgres, real routes)", () => {
  beforeAll(async () => {
    process.env.TRUSTED_PROXY = "1"
    fx = await createLeaseFixture(database(), t)
  }, 120_000)

  afterAll(async () => {
    await cleanupLeaseRows(database(), dealFixtureTenantId(t)).catch(() => undefined)
    await cleanupDealFixture(database(), { tenantId: dealFixtureTenantId(t) })
    await db?.$disconnect()
  }, 60_000)

  it("C1: an entity FML is created NON_NCA / LEASE_NOT_CREDIT_AGREEMENT with its lease terms and CPA scope", async () => {
    fmlDeal = await approveLease(fx, staff, leaseBody(fx, {
      assetId: fx.assets[0], contractType: "FULL_MAINTENANCE_LEASE", rentalTiming: "ARREARS", entityId: fx.evidenced,
    }))
    const deal = await database().assetFinanceDeal.findUniqueOrThrow({ where: { id: fmlDeal }, include: { application: true } })
    expect(deal).toMatchObject({
      contractType: "FULL_MAINTENANCE_LEASE", status: "APPROVED", rentalTiming: "ARREARS", maintenanceMonthlyExclVatCents: 450_000,
      maintenanceRiskModel: "LENDER_RISK", usageAllowancePerYear: 1_500, usageUnit: "HOURS", excessRateCents: 35_000,
      depositCents: 0, balloonCents: 30_000_000,
      // R2m turnover on verified AFS: the CPA threshold (R2m) is reached.
      cpaApplies: false, cpaRule: "CPA_JURISTIC_OVER_THRESHOLD",
    })
    expect(deal.escalationRate?.toString()).toBe("0.08")
    expect(deal.application).toMatchObject({ ncaRegime: "NON_NCA", ncaClassificationRule: "LEASE_NOT_CREDIT_AGREEMENT", status: "APPROVED" })
    expect(await database().ncaRegimeOverride.count({ where: { applicationId: deal.applicationId } })).toBe(0)
  }, 60_000)

  it("C3: the FML signs, contracts, pays the supplier the full cash price and books rentals, not capital and interest", async () => {
    await signLease(fx, database(), setSession, fmlDeal)
    const checklist = await database().payoutChecklistItem.findMany({ where: { dealId: fmlDeal, required: true } })
    expect(checklist.map((c) => c.item)).toContain("NATIS_TITLEHOLDER")
    fmlLoan = await payoutAndBook(fx, database(), staff, fmlDeal)
    const loan = await database().loan.findUniqueOrThrow({
      where: { id: fmlLoan },
      include: { repaymentSchedule: { orderBy: { installmentNo: "asc" } }, leaseRentals: { orderBy: { periodNo: "asc" } }, taxInvoices: true, application: true },
    })
    expect(loan).toMatchObject({
      contractType: "FULL_MAINTENANCE_LEASE", ncaRegime: "NON_NCA", entityId: fx.evidenced, clientId: null,
      balloonAmount: null, totalInterest: 0, initiationFee: 0, cpaApplies: false, cpaRule: "CPA_JURISTIC_OVER_THRESHOLD",
    })
    expect(loan.application.status).toBe("DISBURSED")
    // No inception tax invoice: the supplier invoices the lessor.
    expect(loan.taxInvoices).toHaveLength(0)
    expect(loan.repaymentSchedule).toHaveLength(36)
    expect(loan.leaseRentals).toHaveLength(36)
    const total = loan.repaymentSchedule.reduce((sum, row) => sum + row.totalDue, 0)
    expect(loan.principal).toBe(total)
    expect(loan.totalRepayable).toBe(total)
    expect(loan.outstandingPrincipal).toBe(total)
    loan.repaymentSchedule.forEach((row, i) => {
      const rental = loan.leaseRentals[i]
      expect(row).toMatchObject({ interestDue: 0, feesDue: 0, principalDue: row.totalDue, installmentNo: i + 1 })
      expect(rental).toMatchObject({ scheduleId: row.id, periodNo: i + 1, totalCents: row.totalDue, taxInvoiceId: null })
      expect(rental.totalCents).toBe(rental.rentalExclVatCents + rental.maintenanceExclVatCents + rental.vatCents)
      expect(rental.maintenanceExclVatCents).toBe(i < 12 ? 450_000 : i < 24 ? 479_250 : 510_401) // 450 000 × 1.065^k, half-up
    })
    expect(loan.leaseRentals[12].rentalExclVatCents).toBeGreaterThan(loan.leaseRentals[11].rentalExclVatCents) // escalation
    const payout = await database().payout.findUniqueOrThrow({ where: { dealId: fmlDeal } })
    expect(payout).toMatchObject({ status: "RELEASED", amountCents: 172_500_000 }) // the full cash price incl. VAT
    expect(await database().auditLog.count({ where: { entityId: fmlDeal, action: "ASSET_DEAL_BOOKED" } })).toBe(1)
  }, 120_000)

  it("C3: staff figures read the rentals: balance owed, no arrears yet, settlement = rentals outstanding", async () => {
    const loan = await database().loan.findUniqueOrThrow({ where: { id: fmlLoan }, include: { repaymentSchedule: true } })
    const figures = await staffLoanFigures(database() as never, loan, new Date())
    expect(figures.arrears).toBe(0)
    expect(figures.maturityBalance).toBe(loan.totalRepayable)
    expect(figures.settlementAmount).toBe(loan.totalRepayable)
  }, 30_000)

  it("C3: the statement lists rentals (not capital and interest) and the portal contract shows rentals, no inception invoice", async () => {
    const statement = await runWithTenant(fx.tenantId, () => renderEntityStatementPdf(fx.tenantId, fmlLoan))
    if (statement.kind !== "pdf") throw new Error(`statement: ${statement.kind}`)
    const text = await pdfText(statement.bytes)
    expect(text).toMatch(/FULL MAINTENANCE LEASE AGREEMENT . STATEMENT/)
    expect(text).toContain("Rentals still to fall due")
    expect(text).toContain("By quotation only")
    expect(text).not.toMatch(/interest rate/i)
    const loan = await database().loan.findUniqueOrThrow({ where: { id: fmlLoan } })
    const contract = await runWithTenant(fx.tenantId, () => loadPortalContract(fx.tenantId, fx.evidenced, fmlLoan, fx.director))
    expect(contract?.outstandingCents).toBe(loan.totalRepayable)
    expect(contract?.taxInvoice ?? null).toBeNull()
    expect(contract?.balloonCents).toBe(0)
  }, 30_000)

  it("C1/C3: a sole proprietor's operating lease in advance is NON_NCA, CPA applies, signs alone and starts on its first rental", async () => {
    const firstDue = addMonthsClamped(sastCalendarDate(new Date()), 1)
    olDeal = await approveLease(fx, staff, leaseBody(fx, {
      assetId: fx.assets[1], contractType: "OPERATING_LEASE", rentalTiming: "ADVANCE", clientId: fx.lessee,
      rateBasis: "FIXED", rateMargin: undefined, fixedRate: "0.135", firstDueDate: firstDue,
      usageAllowancePerYear: 30_000, usageUnit: "KM", excessRateCents: 250,
    }))
    const deal = await database().assetFinanceDeal.findUniqueOrThrow({ where: { id: olDeal }, include: { application: true } })
    expect(deal).toMatchObject({ clientId: fx.lessee, entityId: null, cpaApplies: true, cpaRule: "CPA_NATURAL_PERSON", maintenanceMonthlyExclVatCents: null })
    expect(deal.application).toMatchObject({ clientId: fx.lessee, ncaRegime: "NON_NCA", ncaClassificationRule: "LEASE_NOT_CREDIT_AGREEMENT" })
    // The route's default start is today: a lease in advance is refused until it starts on its first rental.
    setSession({ id: fx.officer, email: "officer@lease-it.test", role: "CREDIT_OFFICER", tenantId: fx.tenantId })
    const refused = await signingRoutes(fx.host).prepare(olDeal)
    expect(refused.status).toBe(422)
    expect(await refused.text()).toContain(`starts on its first due date (${firstDue})`)
    await signLease(fx, database(), setSession, olDeal, firstDue)
    const signers = await database().dealSigner.findMany({ where: { dealId: olDeal } })
    expect(signers.map((s) => ({ clientId: s.clientId, document: s.document, method: s.method }))).toEqual([{ clientId: fx.lessee, document: "AGREEMENT", method: "E_SIGN" }])
    const prepared = await database().assetFinanceDeal.findUniqueOrThrow({ where: { id: olDeal } })
    expect(prepared.plannedStartDate && isoOfDbDate(prepared.plannedStartDate)).toBe(firstDue)
    olLoan = await payoutAndBook(fx, database(), staff, olDeal)
    const loan = await database().loan.findUniqueOrThrow({ where: { id: olLoan }, include: { leaseRentals: { orderBy: { periodNo: "asc" } } } })
    expect(loan).toMatchObject({ contractType: "OPERATING_LEASE", ncaRegime: "NON_NCA", clientId: fx.lessee, entityId: null, cpaApplies: true })
    expect(isoOfDbDate(loan.leaseRentals[0].dueDate)).toBe(firstDue)
    expect(loan.leaseRentals.every((r) => r.maintenanceExclVatCents === 0)).toBe(true)
    const statement = await runWithTenant(fx.tenantId, () => renderLeaseStatementPdf(fx.tenantId, olLoan))
    if (statement.kind !== "pdf") throw new Error(`statement: ${statement.kind}`)
    expect(await pdfText(statement.bytes)).toContain("TEST Soleprop")
  }, 180_000)

  it("leases never enter the consumer bureau population, a sole proprietor's included", async () => {
    const candidates = await database().loan.findMany({ where: { tenantId: fx.tenantId, ...CONSUMER_BORROWER_WHERE }, select: { id: true } })
    expect(candidates.map((c) => c.id)).not.toContain(olLoan)
  })

  it("the lease rows are what was booked: a rental cannot be deleted, re-dated or re-priced outside a repricing", async () => {
    const rental = await database().leaseRental.findFirstOrThrow({ where: { loanId: fmlLoan, periodNo: 5 } })
    await expect(database().leaseRental.delete({ where: { id: rental.id } })).rejects.toThrow(/never deleted/)
    await expect(database().leaseRental.update({ where: { id: rental.id }, data: { dueDate: new Date("2030-01-01T00:00:00Z") } })).rejects.toThrow(/fixed/)
    await expect(database().leaseRental.update({ where: { id: rental.id }, data: { rentalExclVatCents: rental.rentalExclVatCents + 1, totalCents: rental.totalCents + 1 } }))
      .rejects.toThrow(/only a repricing/)
    await expect(database().loan.delete({ where: { id: olLoan } })).rejects.toThrow(/never deleted/)
  })
})
