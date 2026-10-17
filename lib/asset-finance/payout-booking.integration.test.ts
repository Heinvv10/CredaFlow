/**
 * Real-Postgres proof of the payout gate and booking (goal §4.10): the
 * checklist created at contract; a payout refused BY THE DATABASE while any
 * required item is open or to a non-APPROVED account; four eyes above the
 * tenant threshold (self-approval refused by route and CHECK), one approver
 * below it; booking atomic (an invoice failure after the Loan insert leaves
 * nothing behind); a booking that writes Loan, schedule, ContractRate, tax
 * invoice and every status move; and two concurrent bookings that make one
 * loan.
 *
 * Only the session is stubbed. Routes, role guard, tenant resolution (by
 * host), feature flag, solver, VAT, audit, triggers and CHECKs are real.
 *
 *   RUN_ASSET_FINANCE_BOOKING_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/asset-finance/payout-booking.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient, type PayoutChecklistItemKind } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { ruleRefuses } from "./lease-servicing.integration-fixture"
import { recordSuretyConsent } from "./surety-consent"
import { dealFixtureTenantId } from "./deal.integration-fixture"
import { sastCalendarDate } from "@/lib/date/sast"
import { dbDate } from "./dates"
import { bookingRoutes, cleanupBookingFixture, createBookingFixture, dealDocument, type BookingFixture, type SessionUser } from "./payout-booking.integration-fixture"

const { session } = vi.hoisted(() => ({ session: { current: null as null | { user: SessionUser } } }))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => session.current) }))

const RUN = process.env.RUN_ASSET_FINANCE_BOOKING_IT === "1"
const suite = RUN ? describe : describe.skip
const db = RUN ? new PrismaClient() : null
const t = randomUUID().replaceAll("-", "").slice(0, 16)
let fx: BookingFixture

function database(): PrismaClient {
  if (!db) throw new Error("RUN_ASSET_FINANCE_BOOKING_IT=1 is required")
  return db
}
const setSession = (user: SessionUser | null) => {
  session.current = user && { user }
}
const staff = (id: string, role: "LOAN_ADMIN" | "CREDIT_OFFICER") => setSession({ id, email: `${id}@booking-it.test`, role, tenantId: fx.tenantId })
const routes = () => bookingRoutes(fx.host)
const sqlError = async (run: () => Promise<unknown>): Promise<string> => {
  try {
    await run()
  } catch (error) {
    return String(error instanceof Error ? error.message : error)
  }
  throw new Error("expected the database to refuse")
}
const rawPayout = (dealId: string, accountId: string, amountCents = 155_250_000) => database().payout.create({
  data: { tenantId: fx.tenantId, dealId, supplierBankAccountId: accountId, amountCents, createdById: fx.adminA },
})
const EVIDENCE: Partial<Record<PayoutChecklistItemKind, Parameters<typeof dealDocument>[3]>> = {
  SUPPLIER_INVOICE_MATCHES_ASSET: "SUPPLIER_INVOICE",
  SUPPLIER_BANK_VERIFIED: "BANK_STATEMENT",
  INSURANCE_NOTES_LENDER: "INSURANCE_NOTING",
  TRACKER_CONFIRMED: "TRACKER_CERTIFICATE",
  DELIVERY_AND_ACCEPTANCE: "DELIVERY_ACCEPTANCE",
  NATIS_TITLEHOLDER: "NATIS_DOCUMENT",
}
async function confirmItem(dealId: string, item: PayoutChecklistItemKind, serial: string) {
  const type = EVIDENCE[item]
  const evidenceDocumentId = type ? await dealDocument(database(), fx, dealId, type) : null
  staff(fx.officer, "CREDIT_OFFICER")
  return routes().confirm(dealId, item, { evidenceDocumentId, attestedSerial: serial, note: null })
}
const serialOf = async (dealId: string) => (await database().assetFinanceDeal.findUniqueOrThrow({ where: { id: dealId }, include: { asset: true } })).asset.serialNumber

suite.sequential("asset-finance payout gate and booking (real Postgres, real routes)", () => {
  beforeAll(async () => {
    vi.stubEnv("TRUSTED_PROXY", "1")
    fx = await createBookingFixture(database(), t, setSession)
  }, 120_000)

  afterAll(async () => {
    vi.unstubAllEnvs()
    if (!db) return
    await cleanupBookingFixture(db, fx ?? { tenantId: dealFixtureTenantId(t) })
    await db.$disconnect()
  })

  it("snapshots the instalment sale CPA scope and refuses changes after approval in the database", async () => {
    expect(await database().assetFinanceDeal.findUniqueOrThrow({ where: { id: fx.dealId } })).toMatchObject({ isaCpaApplies: false, isaCpaRule: "CPA_JURISTIC_OVER_THRESHOLD" })
    await ruleRefuses(database(), { table: "AssetFinanceDeal", trigger: "AssetFinanceDeal_isa_cpa_snapshot" }, /Approved instalment sale CPA scope is fixed/, (tx) => tx.assetFinanceDeal.update({ where: { id: fx.dealId }, data: { isaCpaApplies: true, isaCpaRule: "CPA_FINANCIALS_UNPROVEN" } }))
  })

  it("contracting created the checklist: eNaTIS required only for the registered asset", async () => {
    const rows = await database().payoutChecklistItem.findMany({ where: { tenantId: fx.tenantId } })
    expect(rows).toHaveLength(18)
    const natis = (dealId: string) => rows.find((r) => r.dealId === dealId && r.item === "NATIS_TITLEHOLDER")
    expect(natis(fx.dealId)?.required).toBe(true)
    expect(natis(fx.dealB)?.required).toBe(false)
    expect(rows.every((r) => r.confirmedAt === null)).toBe(true)
  })

  it("a serial that does not match the asset is refused (422, audited); evidence of the wrong type too", async () => {
    const mismatch = await confirmItem(fx.dealId, "SUPPLIER_INVOICE_MATCHES_ASSET", "TESTWRONGSERIAL")
    expect(mismatch.status).toBe(422)
    expect(await database().auditLog.count({ where: { entityId: fx.dealId, action: "ASSET_PAYOUT_REFUSED" } })).toBeGreaterThan(0)
    const wrongType = await dealDocument(database(), fx, fx.dealId, "BANK_STATEMENT")
    expect((await routes().confirm(fx.dealId, "DELIVERY_AND_ACCEPTANCE", { evidenceDocumentId: wrongType })).status).toBe(422)
    const row = await database().payoutChecklistItem.findFirstOrThrow({ where: { dealId: fx.dealId, item: "DELIVERY_AND_ACCEPTANCE" } })
    expect(await sqlError(() => database().payoutChecklistItem.update({
      where: { id: row.id }, data: { confirmedById: fx.officer, confirmedAt: new Date(), evidenceDocumentId: wrongType },
    }))).toContain("the evidence must be a live staff upload on this deal of type DELIVERY_ACCEPTANCE")
  })

  it("the DATABASE refuses a payout while one required item is open", async () => {
    const serial = await serialOf(fx.dealId)
    const kinds = (await database().payoutChecklistItem.findMany({ where: { dealId: fx.dealId }, orderBy: { item: "asc" } })).map((r) => r.item)
    for (const item of kinds.filter((k) => k !== "NATIS_TITLEHOLDER")) {
      expect((await confirmItem(fx.dealId, item, ` ${serial.toLowerCase()} `)).status).toBe(200)
    }
    expect(await sqlError(() => rawPayout(fx.dealId, fx.accountId))).toContain("A payout needs every required checklist item confirmed")
    staff(fx.adminA, "LOAN_ADMIN")
    const route = await routes().createPayout(fx.dealId)
    expect(route.status).toBe(409)
    expect((await route.json()).open).toEqual(["eNaTIS titleholder is the lender"])
  })

  it("a confirmed item is immutable and never deleted; its evidence cannot be deleted (triggers)", async () => {
    const row = await database().payoutChecklistItem.findFirstOrThrow({ where: { dealId: fx.dealId, item: "TRACKER_CONFIRMED" } })
    expect(await sqlError(() => database().payoutChecklistItem.update({ where: { id: row.id }, data: { note: "edited" } })))
      .toContain("A confirmed payout checklist item is immutable")
    expect(await sqlError(() => database().payoutChecklistItem.delete({ where: { id: row.id } }))).toContain("never deleted")
    expect(await sqlError(() => database().entityDocument.update({ where: { id: row.evidenceDocumentId ?? "" }, data: { deletedAt: new Date() } })))
      .toContain("evidences a payout checklist item")
  })

  it("the DATABASE refuses a payout to a PENDING bank account, and one for the wrong amount", async () => {
    expect((await confirmItem(fx.dealId, "NATIS_TITLEHOLDER", "")).status).toBe(200)
    const pending = await database().supplierBankAccount.create({
      data: {
        tenantId: fx.tenantId, supplierId: fx.supplier, bankName: "TEST Bank", branchCode: "000002", accountNumber: "0000000002",
        accountHolder: "TEST Plant Sales (Pty) Ltd", requestedById: fx.officer,
      },
    })
    expect(await sqlError(() => rawPayout(fx.dealId, pending.id))).toContain("APPROVED bank account")
    expect(await sqlError(() => rawPayout(fx.dealId, fx.accountId, 155_250_001))).toContain("cash price incl. VAT less the deposit and the trade-in")
  })

  it("MPA: unknown regime or missing witnessed spouse consent blocks payout in the database and real route", async () => {
    const signer = await database().dealSigner.findFirstOrThrow({ where: { dealId: fx.dealId, document: "SURETYSHIP" } })
    const consent = await database().suretyConsent.findUniqueOrThrow({ where: { signerId: signer.id } })
    await database().suretyConsent.delete({ where: { id: consent.id } })
    expect(await sqlError(() => rawPayout(fx.dealId, fx.accountId))).toContain("every surety marital regime")
    await ruleRefuses(database(), { table: "Payout", trigger: "Payout_surety_consent" }, /every surety marital regime/, (tx) => tx.payout.create({ data: { tenantId: fx.tenantId, dealId: fx.dealId, supplierBankAccountId: fx.accountId, amountCents: 155_250_000, createdById: fx.adminA } }))
    staff(fx.adminA, "LOAN_ADMIN")
    expect((await routes().createPayout(fx.dealId)).status).toBe(409)
    const actor = { tenantId: fx.tenantId, userId: fx.officer }
    await recordSuretyConsent(actor, fx.dealId, signer.id, { maritalRegime: "UNKNOWN", spouseName: null, witnessOne: null, witnessTwo: null, evidenceDocumentId: null })
    expect(await sqlError(() => rawPayout(fx.dealId, fx.accountId))).toContain("every surety marital regime")
    await database().suretyConsent.update({ where: { signerId: signer.id }, data: { maritalRegime: "IN_COMMUNITY" } })
    expect(await sqlError(() => rawPayout(fx.dealId, fx.accountId))).toContain("every surety marital regime")
    const evidenceDocumentId = await dealDocument(database(), fx, fx.dealId, "LEGAL_DOCUMENT")
    const input = { maritalRegime: "IN_COMMUNITY" as const, spouseName: "TEST Spouse", witnessOne: "TEST Witness One", witnessTwo: "TEST Witness Two", evidenceDocumentId }
    staff(fx.officer, "CREDIT_OFFICER")
    expect((await routes().consent(fx.dealId, signer.id, input)).status).toBe(200)
    expect(await database().auditLog.count({ where: { tenantId: fx.tenantId, action: "ASSET_SURETY_CONSENT_VERIFIED" } })).toBe(2)
    expect(await sqlError(() => database().entityDocument.update({ where: { id: evidenceDocumentId }, data: { deletedAt: new Date() } }))).toContain("verified spouse consent document is immutable")
  })

  it("at or above the threshold: PENDING_APPROVAL; the creator cannot approve (route 403, CHECK); a second user can", async () => {
    staff(fx.adminA, "LOAN_ADMIN")
    expect((await routes().createPayout(fx.dealId)).status).toBe(201)
    const payout = await database().payout.findUniqueOrThrow({ where: { dealId: fx.dealId } })
    expect(payout).toMatchObject({ status: "PENDING_APPROVAL", dualApprovalRequired: true, amountCents: 155_250_000, createdById: fx.adminA })
    expect((await routes().approve(fx.dealId)).status).toBe(403)
    expect(await sqlError(() => database().payout.update({
      where: { id: payout.id }, data: { status: "APPROVED", approvedById: fx.adminA, approvedAt: new Date() },
    }))).toContain("Payout_four_eyes")
    staff(fx.officer, "CREDIT_OFFICER")
    expect((await routes().approve(fx.dealId)).status).toBe(403) // no decide_asset_finance
    staff(fx.adminB, "LOAN_ADMIN")
    expect((await routes().approve(fx.dealId)).status).toBe(200)
    expect(await database().payout.findUniqueOrThrow({ where: { id: payout.id } })).toMatchObject({ status: "APPROVED", approvedById: fx.adminB })
    expect(await database().auditLog.count({ where: { entityId: payout.id, action: "ASSET_PAYOUT_APPROVED", userId: fx.adminB } })).toBe(1)
  })

  it("below the threshold with segregation of duties on (the default): still PENDING_APPROVAL, never approved by its creator", async () => {
    const serial = await serialOf(fx.dealB)
    for (const row of await database().payoutChecklistItem.findMany({ where: { dealId: fx.dealB, required: true } })) {
      expect((await confirmItem(fx.dealB, row.item, serial)).status).toBe(200)
    }
    await database().tenantConfig.update({ where: { tenantId: fx.tenantId }, data: { assetPayoutDualApprovalCents: 500_000_000 } })
    expect((await database().tenantConfig.findUniqueOrThrow({ where: { tenantId: fx.tenantId } })).requireSegregationOfDuties).toBe(true)
    expect(await sqlError(() => database().payout.create({
      data: {
        tenantId: fx.tenantId, dealId: fx.dealB, supplierBankAccountId: fx.accountId, amountCents: 155_250_000,
        createdById: fx.adminA, status: "APPROVED", approvedById: fx.adminA, approvedAt: new Date(),
      },
    }))).toContain("is created PENDING_APPROVAL (dual approval from 500000000 cents, and always under segregation of duties)")
    const rolledBack = new Error("rollback")
    await expect(database().$transaction(async (tx) => {
      expect(await tx.payout.create({
        data: { tenantId: fx.tenantId, dealId: fx.dealB, supplierBankAccountId: fx.accountId, amountCents: 155_250_000, createdById: fx.adminA },
        select: { status: true, dualApprovalRequired: true },
      })).toEqual({ status: "PENDING_APPROVAL", dualApprovalRequired: true })
      throw rolledBack
    })).rejects.toBe(rolledBack)
  })

  it("below the threshold with segregation of duties off the creation is the approval; the DB refuses it PENDING or approved by someone else", async () => {
    await database().tenantConfig.update({ where: { tenantId: fx.tenantId }, data: { requireSegregationOfDuties: false } })
    expect(await sqlError(() => rawPayout(fx.dealB, fx.accountId))).toContain("is created APPROVED by its creator")
    expect(await sqlError(() => database().payout.create({
      data: {
        tenantId: fx.tenantId, dealId: fx.dealB, supplierBankAccountId: fx.accountId, amountCents: 155_250_000,
        createdById: fx.adminA, status: "APPROVED", approvedById: fx.adminB, approvedAt: new Date(),
      },
    }))).toContain("Payout_four_eyes")
    staff(fx.adminA, "LOAN_ADMIN")
    expect((await routes().createPayout(fx.dealB)).status).toBe(201)
    expect(await database().payout.findUniqueOrThrow({ where: { dealId: fx.dealB } }))
      .toMatchObject({ status: "APPROVED", dualApprovalRequired: false, approvedById: fx.adminA })
    await database().tenantConfig.update({ where: { tenantId: fx.tenantId }, data: { assetPayoutDualApprovalCents: 100_000_000, requireSegregationOfDuties: true } })
  })

  it("booking is atomic: an invoice failure after the Loan insert leaves nothing behind", async () => {
    const vat = await database().vatConfig.findUniqueOrThrow({ where: { tenantId: fx.tenantId } })
    await database().vatConfig.delete({ where: { id: vat.id } })
    const deal = await database().assetFinanceDeal.findUniqueOrThrow({ where: { id: fx.dealId } })
    staff(fx.adminA, "LOAN_ADMIN")
    const response = await routes().book(fx.dealId)
    expect(response.status).toBe(422)
    expect((await response.json()).error).toMatch(/VAT vendor/)
    expect(await database().loan.count({ where: { applicationId: deal.applicationId } })).toBe(0)
    expect(await database().repaymentSchedule.count({ where: { tenantId: fx.tenantId } })).toBe(0)
    expect(await database().contractRate.count({ where: { tenantId: fx.tenantId } })).toBe(0)
    expect(await database().taxInvoice.count({ where: { tenantId: fx.tenantId } })).toBe(0)
    expect((await database().assetFinanceDeal.findUniqueOrThrow({ where: { id: fx.dealId } }))).toMatchObject({ status: "CONTRACTED", loanId: null })
    expect((await database().loanApplication.findUniqueOrThrow({ where: { id: deal.applicationId } }))).toMatchObject({ status: "APPROVED", disbursedAt: null })
    expect((await database().payout.findUniqueOrThrow({ where: { dealId: fx.dealId } })).status).toBe("APPROVED")
    await database().vatConfig.create({ data: { tenantId: fx.tenantId, vatNumber: vat.vatNumber, registeredName: vat.registeredName, address: vat.address } })
  })

  it("two concurrent bookings make exactly one loan, with every record booking writes", async () => {
    staff(fx.adminA, "LOAN_ADMIN")
    const statuses = (await Promise.all([routes().book(fx.dealId), routes().book(fx.dealId)])).map((r) => r.status).sort()
    expect(statuses).toEqual([201, 409])
    const deal = await database().assetFinanceDeal.findUniqueOrThrow({ where: { id: fx.dealId }, include: { asset: true } })
    const loans = await database().loan.findMany({ where: { applicationId: deal.applicationId } })
    expect(loans).toHaveLength(1)
    const loan = loans[0]
    expect(loan).toMatchObject({
      ncaRegime: "NON_NCA", contractType: "INSTALMENT_SALE", balloonAmount: 20_000_000, assetId: deal.assetId,
      entityId: fx.evidenced, clientId: null, interestModel: "REDUCING_BALANCE", monthlyServiceFee: 0, status: "ACTIVE",
      contractualTotalRepayable: null, contractualTotalInterest: null, totalPaid: 0,
    })
    expect(loan.interestRatePm).toBeCloseTo(0.1175 / 12, 12)
    const rows = await database().repaymentSchedule.findMany({ where: { loanId: loan.id }, orderBy: { installmentNo: "asc" } })
    const sum = (pick: (r: (typeof rows)[number]) => number) => rows.reduce((total, r) => total + pick(r), 0)
    expect(rows).toHaveLength(36)
    expect(sum((r) => r.principalDue)).toBe(loan.principal)
    expect(sum((r) => r.interestDue)).toBe(loan.totalInterest)
    expect(sum((r) => r.totalDue)).toBe(loan.totalRepayable)
    expect(loan.principal).toBe(172_500_000 - 17_250_000) // financed amount; no capitalising rows
    expect(loan.outstandingPrincipal).toBe(loan.principal)
    expect(rows[35].principalDue).toBeGreaterThan(20_000_000)
    expect(rows.every((r) => r.status === "PENDING" && r.principalDue >= 0 && r.interestDue >= 0 && r.totalDue === r.principalDue + r.interestDue)).toBe(true)
    const signedStart = deal.plannedStartDate && sastCalendarDate(deal.plannedStartDate)
    expect(signedStart).not.toBeNull()
    expect(sastCalendarDate(loan.startDate)).toBe(signedStart)

    const rates = await database().contractRate.findMany({ where: { loanId: loan.id } })
    expect(rates).toHaveLength(1)
    expect(rates[0].effectiveDate).toEqual(dbDate(signedStart ?? ""))
    expect(rates[0].resultingRate.toString()).toBe("0.1175")
    expect(rates[0].margin?.toString()).toBe("0.01")
    expect(rates[0].newInstalmentCents).toBe(deal.baseInstalmentCents)
    const invoices = await database().taxInvoice.findMany({ where: { loanId: loan.id }, include: { lines: true } })
    expect(invoices).toHaveLength(1)
    expect(invoices[0]).toMatchObject({ totalInclVatCents: 172_500_000, recipientName: "TEST Earthmoving (Pty) Ltd", recipientVatNumber: "4000000002" })
    expect(invoices[0].lines).toHaveLength(1)

    expect(deal).toMatchObject({ status: "BOOKED", loanId: loan.id })
    expect(deal.asset.releasedAt).toBeNull()
    expect(await database().loanApplication.findUniqueOrThrow({ where: { id: deal.applicationId } }))
      .toMatchObject({ status: "DISBURSED", disbursedAt: expect.any(Date) })
    const payout = await database().payout.findUniqueOrThrow({ where: { dealId: fx.dealId } })
    expect(payout).toMatchObject({ status: "RELEASED", releasedById: fx.adminA, releasedAt: expect.any(Date) })
    expect(await database().auditLog.count({ where: { entityId: fx.dealId, action: "ASSET_DEAL_BOOKED" } })).toBe(1)
    expect(await sqlError(() => database().payout.update({ where: { id: payout.id }, data: { amountCents: 1 } }))).toContain("A released payout is immutable")
    expect(await sqlError(() => database().assetFinanceDeal.update({ where: { id: fx.dealId }, data: { status: "CONTRACTED" } })))
      .toContain("A booked deal keeps its status and its loan")
  })

  it("the tax invoice downloads as a PDF and the read is logged", async () => {
    const invoice = await database().taxInvoice.findFirstOrThrow({ where: { tenantId: fx.tenantId } })
    staff(fx.officer, "CREDIT_OFFICER")
    const response = await routes().invoice(invoice.id)
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toBe("application/pdf")
    expect(Buffer.from(await response.arrayBuffer()).subarray(0, 5).toString()).toBe("%PDF-")
    expect(await database().documentAccessLog.count({ where: { documentId: invoice.id, accessorId: fx.officer, action: "view" } })).toBe(1)
  })

  // The setting governs who may APPROVE, at the approval. A payout approved by
  // its creator while it was off stays approved once it is switched back on,
  // as a loan approved before the switch stays approved: re-opening approvals
  // retroactively would strand deals already contracted with the supplier.
  it("the single-approved deal books too, also after segregation of duties is switched back on", async () => {
    expect((await database().tenantConfig.findUniqueOrThrow({ where: { tenantId: fx.tenantId } })).requireSegregationOfDuties).toBe(true)
    expect(await database().payout.findUniqueOrThrow({ where: { dealId: fx.dealB } }))
      .toMatchObject({ status: "APPROVED", dualApprovalRequired: false, approvedById: fx.adminA, createdById: fx.adminA })
    staff(fx.adminA, "LOAN_ADMIN")
    expect((await routes().book(fx.dealB)).status).toBe(201)
    expect((await database().assetFinanceDeal.findUniqueOrThrow({ where: { id: fx.dealB } })).status).toBe("BOOKED")
  })
})
