/**
 * Real-Postgres proof that the booked loan is the signed agreement (review
 * items 1–3): the terms fixed at document preparation (planned start date,
 * instalment, rate, interest, arrears terms) are what booking writes, even
 * when the booking day is not the indicative start and the product changes
 * after signing; a reference rate approved after signing makes booking refuse
 * (terms_changed); the stuck deal is cancelled whole; and the contract step
 * refuses an agreement that no longer renders to the signed digest.
 *
 * Only the session is stubbed. Routes, solver, renderer, triggers and CHECKs
 * are real.
 *
 *   RUN_ASSET_FINANCE_TERMS_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/asset-finance/booking-terms.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { NextRequest } from "next/server"
import { PrismaClient, type PayoutChecklistItemKind } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { dealFixtureTenantId } from "./deal.integration-fixture"
import { sastCalendarDate } from "@/lib/date/sast"
import { prisma } from "@/lib/prisma"
import { runWithTenant } from "@/lib/tenant-scope"
import { dbDate, isoOfDbDate } from "./dates"
import { dealStartDate } from "./deal-structure"
import { loadDealDocumentData } from "./documents/deal-document-data"
import { toScheduleRecord } from "./schedule-records"
import { signingRoutes } from "./deal-signing.integration-fixture"
import {
  approveDeal, bookingRoutes, cleanupBookingFixture, createBookingFixture, dealDocument, prepareAndSign,
  type BookingFixture, type SessionUser,
} from "./payout-booking.integration-fixture"

const { session } = vi.hoisted(() => ({ session: { current: null as null | { user: SessionUser } } }))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => session.current) }))

import { POST as cancelRoute } from "@/app/api/asset-finance/deals/[id]/cancel/route"

const RUN = process.env.RUN_ASSET_FINANCE_TERMS_IT === "1"
const suite = RUN ? describe : describe.skip
const db = RUN ? new PrismaClient() : null
const t = randomUUID().replaceAll("-", "").slice(0, 16)
let fx: BookingFixture
let dealC = ""
let dealCStart = ""

function database(): PrismaClient {
  if (!db) throw new Error("RUN_ASSET_FINANCE_TERMS_IT=1 is required")
  return db
}
const setSession = (user: SessionUser | null) => {
  session.current = user && { user }
}
const staff = (id: string, role: "LOAN_ADMIN" | "CREDIT_OFFICER") => setSession({ id, email: `${id}@terms-it.test`, role, tenantId: fx.tenantId })
const routes = () => bookingRoutes(fx.host)
const today = () => sastCalendarDate(new Date())
const EVIDENCE: Partial<Record<PayoutChecklistItemKind, Parameters<typeof dealDocument>[3]>> = {
  SUPPLIER_INVOICE_MATCHES_ASSET: "SUPPLIER_INVOICE", SUPPLIER_BANK_VERIFIED: "BANK_STATEMENT", INSURANCE_NOTES_LENDER: "INSURANCE_NOTING",
  TRACKER_CONFIRMED: "TRACKER_CERTIFICATE", DELIVERY_AND_ACCEPTANCE: "DELIVERY_ACCEPTANCE", NATIS_TITLEHOLDER: "NATIS_DOCUMENT",
}
async function payOut(dealId: string) {
  const deal = await database().assetFinanceDeal.findUniqueOrThrow({ where: { id: dealId }, include: { asset: true } })
  for (const row of await database().payoutChecklistItem.findMany({ where: { dealId, required: true } })) {
    const type = EVIDENCE[row.item]
    const evidenceDocumentId = type ? await dealDocument(database(), fx, dealId, type) : null
    staff(fx.officer, "CREDIT_OFFICER")
    expect((await routes().confirm(dealId, row.item, { evidenceDocumentId, attestedSerial: deal.asset.serialNumber.toLowerCase(), note: null })).status).toBe(200)
  }
  staff(fx.adminA, "LOAN_ADMIN")
  expect((await routes().createPayout(dealId)).status).toBe(201)
}
const cancel = (dealId: string, reason: string) => cancelRoute(new NextRequest(`http://${fx.host}/api/asset-finance/deals/${dealId}/cancel`, {
  method: "POST", headers: { host: fx.host, "content-type": "application/json" }, body: JSON.stringify({ reason }),
}), { params: Promise.resolve({ id: dealId }) })

suite.sequential("the booked loan is the signed agreement (real Postgres, real routes)", () => {
  beforeAll(async () => {
    vi.stubEnv("TRUSTED_PROXY", "1")
    fx = await createBookingFixture(database(), t, setSession, { dealAArrears: { margin: "0.02", feeCents: 45_000 } })
    // One approver: payouts are created APPROVED.
    await database().tenantConfig.update({ where: { tenantId: fx.tenantId }, data: { assetPayoutDualApprovalCents: 500_000_000 } })
  }, 180_000)

  afterAll(async () => {
    vi.unstubAllEnvs()
    if (!db) return
    await cleanupBookingFixture(db, fx ?? { tenantId: dealFixtureTenantId(t) })
    await db.$disconnect()
  })

  it("preparation fixed the contract terms on each deal: start, figures, the product's arrears terms, the signers", async () => {
    const [a, b] = await Promise.all([fx.dealId, fx.dealB].map((id) => database().assetFinanceDeal.findUniqueOrThrow({ where: { id } })))
    expect(a.plannedStartDate && isoOfDbDate(a.plannedStartDate)).toBe(dealStartDate(isoOfDbDate(a.firstDueDate)))
    expect(a.signedResultingRate?.toString()).toBe("0.1175")
    expect(a.signedArrearsMarginRate?.toString()).toBe("0.02")
    expect(a.signedCollectionFeeCents).toBe(45_000)
    expect(b.signedArrearsMarginRate).toBeNull()
    expect(b.signedCollectionFeeCents).toBe(0)
    expect(a.preparedSigners).toHaveLength(5)
    expect(a.signedBaseInstalmentCents).toBeGreaterThan(0)
  })

  it("product edited after signing: the loan still uses the signed schedule and arrears terms", async () => {
    await database().loanProduct.update({ where: { id: fx.product }, data: { nonNcaDefaultInterestMargin: "0.20", nonNcaCollectionFeeCents: 99_900 } })
    await payOut(fx.dealId)
    staff(fx.adminA, "LOAN_ADMIN")
    expect((await routes().book(fx.dealId)).status).toBe(201)
    const deal = await database().assetFinanceDeal.findUniqueOrThrow({ where: { id: fx.dealId }, include: { loan: true } })
    const loan = deal.loan
    if (!loan || !deal.plannedStartDate) throw new Error("not booked")
    expect(sastCalendarDate(loan.startDate)).toBe(isoOfDbDate(deal.plannedStartDate))
    expect(deal.baseInstalmentCents).toBe(deal.signedBaseInstalmentCents)
    expect(loan.assetFinanceWeights).toEqual(deal.weights)
    expect(loan.nonNcaDefaultInterestMargin?.toString()).toBe("0.02")
    expect(loan.nonNcaCollectionFeeCents).toBe(45_000)

    const signed = await runWithTenant(fx.tenantId, () => loadDealDocumentData(prisma, fx.tenantId, fx.dealId))
    if (!signed) throw new Error("no document data")
    expect(signed.pricing.totalInterestCents).toBe(deal.signedTotalInterestCents)
    const booked = await database().repaymentSchedule.findMany({ where: { loanId: loan.id }, orderBy: { installmentNo: "asc" } })
    expect(booked.map((r) => [r.installmentNo, r.dueDate.toISOString(), r.principalDue, r.interestDue, r.totalDue]))
      .toEqual(signed.schedule.map(toScheduleRecord).map((r) => [r.installmentNo, r.dueDate.toISOString(), r.principalDue, r.interestDue, r.totalDue]))
    expect(booked.map((r) => r.assetFinanceOpeningBalanceCents)).toEqual(signed.schedule.map((r) => r.openingBalanceCents))
    const rates = await database().contractRate.findMany({ where: { loanId: loan.id } })
    expect(rates.map((r) => [r.effectiveDate, r.resultingRate.toString()])).toEqual([[deal.plannedStartDate, "0.1175"]])
  })

  it("a reference rate approved after signing: booking is refused terms_changed (409, audited), nothing written", async () => {
    await payOut(fx.dealB)
    const moved = await database().referenceRate.create({
      data: { tenantId: fx.tenantId, basis: "PRIME", effectiveDate: dbDate(today()), rate: "0.1100", requestedById: fx.adminA },
    })
    await database().referenceRate.update({ where: { id: moved.id }, data: { status: "APPROVED", decidedById: fx.adminB, decidedAt: new Date() } })
    staff(fx.adminA, "LOAN_ADMIN")
    const response = await routes().book(fx.dealB)
    expect(response.status).toBe(409)
    expect((await response.json()).error).toMatch(/not the signed 0.1175/)
    expect(await database().auditLog.count({ where: { entityId: fx.dealB, action: "ASSET_PAYOUT_REFUSED", newValue: { path: ["reason"], equals: "terms_changed" } } })).toBe(1)
    const deal = await database().assetFinanceDeal.findUniqueOrThrow({ where: { id: fx.dealB } })
    expect(deal).toMatchObject({ status: "CONTRACTED", loanId: null })
    expect(await database().loan.count({ where: { applicationId: deal.applicationId } })).toBe(0)
  })

  it("the stuck deal is cancelled: payout, deal and application CANCELLED, asset released and its serial free again", async () => {
    staff(fx.officer, "CREDIT_OFFICER")
    expect((await cancel(fx.dealB, "Rate moved after signing")).status).toBe(403)
    staff(fx.adminA, "LOAN_ADMIN")
    expect((await cancel(fx.dealB, "too short")).status).toBe(400)
    expect((await cancel(fx.dealB, "PRIME moved after signing; re-quote on a new deal")).status).toBe(200)
    const deal = await database().assetFinanceDeal.findUniqueOrThrow({ where: { id: fx.dealB }, include: { payout: true, application: true, asset: true } })
    expect(deal).toMatchObject({ status: "CANCELLED", cancelledById: fx.adminA, cancelReason: "PRIME moved after signing; re-quote on a new deal" })
    expect(deal.payout).toMatchObject({ status: "CANCELLED", cancelledById: fx.adminA })
    expect(deal.application.status).toBe("CANCELLED")
    expect(deal.asset.releasedAt).toBeInstanceOf(Date)
    expect(await database().auditLog.count({ where: { entityId: fx.dealB, action: "ASSET_DEAL_CANCELLED", userId: fx.adminA } })).toBe(1)
    const again = await database().financedAsset.create({
      data: {
        tenantId: fx.tenantId, assetClass: "EXCAVATOR", make: "TEST", model: "EX-2", year: 2025, serialNumber: deal.asset.serialNumber,
        cashPriceExclVatCents: 150_000_000, vatCents: 22_500_000,
      },
    })
    expect(again.serialNumber).toBe(deal.asset.serialNumber)
    expect((await cancel(fx.dealB, "Cancelled a second time")).status).toBe(409)
    expect((await cancel(fx.dealId, "A booked deal is never cancelled")).status).toBe(409)
  })

  it("contract re-renders the agreement: a deal whose agreement no longer hashes to the signed digest is refused (409, audited)", async () => {
    dealC = await approveDeal(fx, fx.assets[2], (id, role) => setSession({ id, email: `${id}@terms-it.test`, role, tenantId: fx.tenantId }), database(), 2)
    const created = await database().assetFinanceDeal.findUniqueOrThrow({ where: { id: dealC }, select: { firstDueDate: true } })
    dealCStart = dealStartDate(isoOfDbDate(created.firstDueDate))
    await prepareAndSign(fx, dealC, setSession, database(), [], dealCStart)
    const entity = await database().businessEntity.findUniqueOrThrow({ where: { id: fx.evidenced } })
    await database().businessEntity.update({ where: { id: fx.evidenced }, data: { addressLine1: "10 Other Yard" } })
    staff(fx.officer, "CREDIT_OFFICER")
    const refused = await signingRoutes(fx.host).contract(dealC)
    expect(refused.status).toBe(409)
    expect((await refused.json()).error).toMatch(/not the one that was signed/)
    expect(await database().auditLog.count({ where: { entityId: dealC, action: "ASSET_DEAL_SIGNING_REFUSED" } })).toBe(1)
    expect((await database().assetFinanceDeal.findUniqueOrThrow({ where: { id: dealC } })).status).toBe("APPROVED")
    await database().businessEntity.update({ where: { id: fx.evidenced }, data: { addressLine1: entity.addressLine1 } })
    expect((await signingRoutes(fx.host).contract(dealC)).status).toBe(200)
  })

  it("a start date after the booking day: the loan starts on it, the invoice is dated the booking day", async () => {
    await database().financedAsset.update({ where: { id: fx.assets[2] }, data: { trackerId: "TRK-C", trackerProvider: "TEST Tracking", lenderNotedConfirmed: true } })
    await payOut(dealC)
    staff(fx.adminA, "LOAN_ADMIN")
    expect((await routes().book(dealC)).status).toBe(201)
    const deal = await database().assetFinanceDeal.findUniqueOrThrow({ where: { id: dealC }, include: { loan: true } })
    if (!deal.loan) throw new Error("not booked")
    expect(sastCalendarDate(deal.loan.startDate)).toBe(dealCStart)
    expect(deal.signedResultingRate?.toString()).toBe("0.12")
    const rates = await database().contractRate.findMany({ where: { loanId: deal.loan.id } })
    expect(rates.map((r) => [isoOfDbDate(r.effectiveDate), r.resultingRate.toString()])).toEqual([[dealCStart, "0.12"]])
    const invoice = await database().taxInvoice.findFirstOrThrow({ where: { loanId: deal.loan.id } })
    expect(isoOfDbDate(invoice.supplyDate)).toBe(today())
  })
})
