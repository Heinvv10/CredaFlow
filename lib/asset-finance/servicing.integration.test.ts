/**
 * Real-Postgres proof of asset-finance servicing (goal §4.11): a deal is
 * booked through the real routes, time moves past instalment 1 (the clock is
 * faked, nothing sleeps), the charges sweep posts the agreement's NON_NCA
 * default interest and one collection fee and sets the arrears, a manual
 * receipt for everything overdue clears them in the contract's allocation
 * order, the settlement quote carries the balloon, the statement renders with
 * the entity as borrower (access logged), and reminder recipients are the
 * entity's active directors only, never its sureties.
 *
 * The product's terms are edited AFTER booking: the charges must still be the
 * loan's booked terms.
 *
 *   RUN_ASSET_FINANCE_SERVICING_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/asset-finance/servicing.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient, type PayoutChecklistItemKind } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { dealFixtureTenantId } from "./deal.integration-fixture"
import { NextRequest } from "next/server"
import { applyManualReceipt, type PaymentDb } from "@/lib/loan/apply-payment"
import { sweepTenantCharges, type SweepDb } from "@/lib/loan/charges-sweep"
import { loanSettlementFigures } from "@/lib/loan/charges-summary"
import type { ChargesTx } from "@/lib/loan/charges-replay"
import { GET as statementRoute } from "@/app/api/loans/[id]/statement/route"
import { entityContactRecipients, type EntityContactsDb } from "./entity-contacts"
import { loadPortalContract } from "./portal-contract"
import { bookingRoutes, cleanupBookingFixture, createBookingFixture, dealDocument, type BookingFixture, type SessionUser } from "./payout-booking.integration-fixture"

const { session } = vi.hoisted(() => ({ session: { current: null as null | { user: SessionUser } } }))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => session.current) }))

const RUN = process.env.RUN_ASSET_FINANCE_SERVICING_IT === "1"
const suite = RUN ? describe : describe.skip
const db = RUN ? new PrismaClient() : null
const t = randomUUID().replaceAll("-", "").slice(0, 16)
const DAY = 86_400_000
const BOOKED_MARGIN = "0.05"
const BOOKED_FEE = 25_000
let fx: BookingFixture
let loanId = ""

function database(): PrismaClient {
  if (!db) throw new Error("RUN_ASSET_FINANCE_SERVICING_IT=1 is required")
  return db
}
const setSession = (user: SessionUser | null) => {
  session.current = user && { user }
}
const staff = (id: string, role: "LOAN_ADMIN" | "CREDIT_OFFICER") => setSession({ id, email: `${id}@servicing-it.test`, role, tenantId: fx.tenantId })
const EVIDENCE: Partial<Record<PayoutChecklistItemKind, Parameters<typeof dealDocument>[3]>> = {
  SUPPLIER_INVOICE_MATCHES_ASSET: "SUPPLIER_INVOICE",
  SUPPLIER_BANK_VERIFIED: "BANK_STATEMENT",
  INSURANCE_NOTES_LENDER: "INSURANCE_NOTING",
  TRACKER_CONFIRMED: "TRACKER_CERTIFICATE",
  DELIVERY_AND_ACCEPTANCE: "DELIVERY_ACCEPTANCE",
  NATIS_TITLEHOLDER: "NATIS_DOCUMENT",
}
const schedule = () => database().repaymentSchedule.findMany({ where: { loanId }, orderBy: { installmentNo: "asc" } })
const loan = () => database().loan.findUniqueOrThrow({ where: { id: loanId } })

suite.sequential("asset-finance servicing: book → miss → charges → receipt → settle (real Postgres)", () => {
  beforeAll(async () => {
    vi.stubEnv("TRUSTED_PROXY", "1")
    const d = database()
    // The product's terms when deal A's documents are prepared: the signed terms.
    fx = await createBookingFixture(d, t, setSession, { dealAArrears: { margin: BOOKED_MARGIN, feeCents: BOOKED_FEE } })
    // One approver (segregation of duties off): the payout is created APPROVED.
    await d.tenantConfig.update({ where: { tenantId: fx.tenantId }, data: { assetPayoutDualApprovalCents: 500_000_000, requireSegregationOfDuties: false } })
    const serial = (await d.assetFinanceDeal.findUniqueOrThrow({ where: { id: fx.dealId }, include: { asset: true } })).asset.serialNumber
    for (const row of await d.payoutChecklistItem.findMany({ where: { dealId: fx.dealId, required: true } })) {
      const type = EVIDENCE[row.item]
      const evidenceDocumentId = type ? await dealDocument(d, fx, fx.dealId, type) : null
      staff(fx.officer, "CREDIT_OFFICER")
      expect((await bookingRoutes(fx.host).confirm(fx.dealId, row.item, { evidenceDocumentId, attestedSerial: serial, note: null })).status).toBe(200)
    }
    staff(fx.adminA, "LOAN_ADMIN")
    expect((await bookingRoutes(fx.host).createPayout(fx.dealId)).status).toBe(201)
    const booked = await bookingRoutes(fx.host).book(fx.dealId)
    expect(booked.status).toBe(201)
    loanId = ((await booked.json()) as { loanId: string }).loanId
    // Default charges go live now, before anything is overdue.
    await d.tenantConfig.update({ where: { tenantId: fx.tenantId }, data: { defaultChargesEnabled: true, defaultChargesStartedAt: new Date() } })
    // The product is repriced after booking; the signed agreement is not.
    await d.loanProduct.update({ where: { id: fx.product }, data: { nonNcaDefaultInterestMargin: "0.20", nonNcaCollectionFeeCents: 99_900 } })
  }, 180_000)

  afterAll(async () => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
    if (!db) return
    if (fx) {
      await db.$transaction([
        db.$executeRawUnsafe("SET LOCAL session_replication_role = replica"),
        db.documentAccessLog.deleteMany({ where: { documentId: loanId } }),
        db.loanCharge.deleteMany({ where: { tenantId: fx.tenantId } }),
        db.payment.deleteMany({ where: { tenantId: fx.tenantId } }),
        db.loanNote.deleteMany({ where: { tenantId: fx.tenantId } }),
      ])
    }
    await cleanupBookingFixture(db, fx ?? { tenantId: dealFixtureTenantId(t) })
    await db.$disconnect()
  })

  it("booking copied the deal's signed arrears terms (the product's at preparation) onto the loan", async () => {
    expect(await loan()).toMatchObject({ ncaRegime: "NON_NCA", nonNcaCollectionFeeCents: BOOKED_FEE, clientId: null })
    expect((await loan()).nonNcaDefaultInterestMargin?.toString()).toBe(BOOKED_MARGIN)
  })

  it("10 days after instalment 1 falls due: one collection fee, default interest at contract + booked margin, arrears set", async () => {
    const [first] = await schedule()
    const now = new Date(first.dueDate.getTime() + 10 * DAY + 10 * 3_600_000)
    vi.useFakeTimers({ toFake: ["Date"], now })
    const swept = await sweepTenantCharges(database() as unknown as SweepDb, fx.tenantId, now, { source: "servicing-it" })
    expect(swept.failures).toEqual([])

    const charges = await database().loanCharge.findMany({ where: { loanId }, orderBy: { day: "asc" } })
    const fees = charges.filter((c) => c.type === "COLLECTION_FEE")
    expect(fees).toHaveLength(1)
    expect(fees[0].amount).toBe(BOOKED_FEE)
    expect(charges.every((c) => c.type === "COLLECTION_FEE" || c.type === "DEFAULT_INTEREST")).toBe(true)
    // Overdue base = instalment 1 (its interest and principal); 9 complete
    // days after the due date; (contract annual rate + 5%) / 365.
    const l = await loan()
    const expected = first.totalDue * (l.interestRatePm * 12 + Number(BOOKED_MARGIN)) / 365 * 9
    const interest = charges.filter((c) => c.type === "DEFAULT_INTEREST").reduce((s, c) => s + c.amount, 0)
    expect(Math.abs(interest - expected)).toBeLessThanOrEqual(1)
    expect(l).toMatchObject({ daysInArrears: 10, arrearsAmount: first.totalDue, chargesAccrued: BOOKED_FEE + interest, chargesOutstanding: BOOKED_FEE + interest })
  })

  it("a receipt for the arrears plus charges pays default interest, the fee and instalment 1, and clears the arrears", async () => {
    const before = await loan()
    const [first] = await schedule()
    const amount = before.arrearsAmount + before.chargesOutstanding
    const result = await applyManualReceipt(database() as unknown as PaymentDb, {
      loanId, tenantId: fx.tenantId, amount, paymentMethod: "EFT", reference: before.reference, capturedById: fx.adminA,
    })
    expect(result.payment).toMatchObject({ amount, allocationStatus: "ALLOCATED", chargeFeesAllocated: BOOKED_FEE })
    expect(result.payment.defaultInterestAllocated).toBe(before.chargesOutstanding - BOOKED_FEE)
    expect(result.excessPayment).toBeNull()

    const after = await loan()
    const rows = await schedule()
    expect(rows[0]).toMatchObject({ status: "PAID", totalPaid: first.totalDue })
    expect(rows.slice(1).every((r) => r.totalPaid === 0)).toBe(true)
    expect(after).toMatchObject({
      arrearsAmount: 0, daysInArrears: 0, chargesOutstanding: 0, chargesAccrued: before.chargesAccrued,
      totalPaid: first.totalDue, outstandingPrincipal: before.principal - first.principalDue, status: "ACTIVE",
    })
  })

  it("the settlement quote is every remaining instalment, the balloon on the last one included", async () => {
    const l = await database().loan.findUniqueOrThrow({ where: { id: loanId }, include: { repaymentSchedule: { orderBy: { installmentNo: "asc" } } } })
    const figures = await loanSettlementFigures(database() as unknown as ChargesTx, l, new Date())
    const remaining = l.repaymentSchedule.slice(1)
    expect(remaining.at(-1)?.principalDue).toBeGreaterThan(l.balloonAmount ?? 0)
    expect(l.balloonAmount).toBe(20_000_000)
    expect(figures.chargesOutstanding).toBe(0)
    expect(figures.totalToSettle).toBe(remaining.reduce((s, r) => s + r.totalDue, 0))
    // The portal labels the balance from the live flag, not from charge lines: live charges with none owed is still a settlement figure.
    const view = await loadPortalContract(fx.tenantId, fx.evidenced, loanId, fx.director, new Date())
    expect(view).toMatchObject({ chargesLive: true, chargeLines: [], outstandingCents: figures.totalToSettle })
  })

  it("staff download the statement with the entity as borrower, and the access is logged; a client is refused", async () => {
    const request = () => new NextRequest(`http://${fx.host}/api/loans/${loanId}/statement`, { headers: { host: fx.host } })
    staff(fx.officer, "CREDIT_OFFICER")
    const response = await statementRoute(request(), { params: Promise.resolve({ id: loanId }) })
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toBe("application/pdf")
    expect(Buffer.from(await response.arrayBuffer()).subarray(0, 5).toString()).toBe("%PDF-")
    expect(await database().documentAccessLog.count({ where: { documentId: loanId, accessorType: "staff", accessorId: fx.officer, action: "download" } })).toBe(1)

    setSession({ id: fx.director, email: "director@servicing-it.test", role: "CLIENT", tenantId: fx.tenantId })
    expect((await statementRoute(request(), { params: Promise.resolve({ id: loanId }) })).status).toBe(403)
    expect(await database().documentAccessLog.count({ where: { documentId: loanId } })).toBe(1)
  })

  it("reminders go to active directors, trustees and signatories only: never sureties, never an inactive director", async () => {
    const d = database()
    const sureties = await d.entityRelationship.findMany({ where: { entityId: fx.evidenced, role: "SURETY", clientId: { not: fx.director } } })
    expect(sureties.length).toBeGreaterThan(0)
    // A surety who once was a director, now inactive.
    await d.entityRelationship.create({ data: { tenantId: fx.tenantId, entityId: fx.evidenced, clientId: sureties[0].clientId, role: "DIRECTOR", active: false } })
    const recipients = await entityContactRecipients(d as unknown as EntityContactsDb, fx.tenantId, fx.evidenced)
    // The director also stands surety: still one recipient, as director.
    expect(recipients.map((r) => r.clientId)).toEqual([fx.director])
  })
})
