/**
 * Real-Postgres fixture for the portal contract suite: the booking fixture's
 * deal A taken through the real staff routes to a booked Loan (every payout
 * checklist item confirmed with evidence, the payout created by one admin and
 * approved by another, then booked). The fixture's director is DIRECTOR and
 * SURETY of the company; suretyA and suretyB are SURETY only. Every value is
 * synthetic. Not a test file.
 */
import type { PayoutChecklistItemKind, PrismaClient } from "@prisma/client"
import { expect } from "vitest"
import {
  bookingRoutes, cleanupBookingFixture, createBookingFixture, dealDocument,
  type BookingFixture, type SetSession,
} from "./payout-booking.integration-fixture"

export interface BookedContractFixture extends BookingFixture {
  loanId: string
}

const EVIDENCE: Partial<Record<PayoutChecklistItemKind, Parameters<typeof dealDocument>[3]>> = {
  SUPPLIER_INVOICE_MATCHES_ASSET: "SUPPLIER_INVOICE",
  SUPPLIER_BANK_VERIFIED: "BANK_STATEMENT",
  INSURANCE_NOTES_LENDER: "INSURANCE_NOTING",
  TRACKER_CONFIRMED: "TRACKER_CERTIFICATE",
  DELIVERY_AND_ACCEPTANCE: "DELIVERY_ACCEPTANCE",
  NATIS_TITLEHOLDER: "NATIS_DOCUMENT",
}

export async function createBookedContractFixture(db: PrismaClient, t: string, setSession: SetSession, options: { dealAArrears?: { margin: string; feeCents: number } } = {}): Promise<BookedContractFixture> {
  const fx = await createBookingFixture(db, t, setSession, options)
  const staff = (id: string, role: "LOAN_ADMIN" | "CREDIT_OFFICER") =>
    setSession({ id, email: `${id}@booking-it.test`, role, tenantId: fx.tenantId })
  const routes = bookingRoutes(fx.host)
  const deal = await db.assetFinanceDeal.findUniqueOrThrow({ where: { id: fx.dealId }, include: { asset: true } })

  for (const row of await db.payoutChecklistItem.findMany({ where: { dealId: fx.dealId, required: true } })) {
    const type = EVIDENCE[row.item]
    const evidenceDocumentId = type ? await dealDocument(db, fx, fx.dealId, type) : null
    staff(fx.officer, "CREDIT_OFFICER")
    const confirmed = await routes.confirm(fx.dealId, row.item, { evidenceDocumentId, attestedSerial: deal.asset.serialNumber, note: null })
    expect(confirmed.status).toBe(200)
  }
  staff(fx.adminA, "LOAN_ADMIN")
  expect((await routes.createPayout(fx.dealId)).status).toBe(201)
  if ((await db.payout.findUniqueOrThrow({ where: { dealId: fx.dealId } })).status === "PENDING_APPROVAL") {
    staff(fx.adminB, "LOAN_ADMIN")
    expect((await routes.approve(fx.dealId)).status).toBe(200)
  }
  staff(fx.adminA, "LOAN_ADMIN")
  expect((await routes.book(fx.dealId)).status).toBe(201)
  const booked = await db.assetFinanceDeal.findUniqueOrThrow({ where: { id: fx.dealId } })
  if (!booked.loanId) throw new Error("booking left the deal without a loan")
  setSession(null)
  return { ...fx, loanId: booked.loanId }
}

/** Access-log rows for the loan's statement reads go first; then the booking fixture. */
export async function cleanupBookedContractFixture(db: PrismaClient, fx: BookedContractFixture | undefined): Promise<void> {
  if (!fx) return
  await db.documentAccessLog.deleteMany({ where: { documentId: fx.loanId } })
  await cleanupBookingFixture(db, fx)
}
