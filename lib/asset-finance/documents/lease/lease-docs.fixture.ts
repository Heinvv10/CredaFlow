// Synthetic data for the lease servicing document tests (slice 3, C9): the
// renderer inputs and the database rows the loaders read. Obviously fake.
import type { ExpiryNoticeData, InspectionReportData, LeaseDocBase, LeaseDocLender, TerminationQuoteData } from "./lease-docs-types"

export const LENDER: LeaseDocLender = {
  legalName: "Synthetic Lessor (Pty) Ltd",
  tradingName: "Synthetic Lessor",
  registeredOfficeLines: ["1 Test Street", "Testville", "0001"],
  publicEmail: "info@lessor.test",
  publicPhone: "+27 11 000 0001",
  collectionsEmail: "collections@lessor.test",
  collectionsPhone: "+27 11 000 0002",
}

export const BASE: LeaseDocBase = {
  loanId: "loan-1",
  reference: "TEST-LSE-0001",
  lessee: "TEST Lessee Holdings (2020/000001/07)",
  asset: "2025 Testmake Loader 9000, serial SN-TEST-001",
  draft: true,
  naturalPerson: false,
}

export const BASIS = "Present value of the remaining rentals at the contract rate, less the net realisable or re-let value of the returned goods, plus actual documented recovery, refurbishment and re-letting costs. No percentage penalty. The charge is floored at zero and capped below undiscounted remaining rentals. CPA Regulation 5(2) applies; cancellation is effective on 20 business days notice without accepting this quote."


export const NOTICE: ExpiryNoticeData = {
  ...BASE, noticeId: "notice-1", expiryDate: "2027-06-30", queuedOn: "2027-02-01", extensionNoticeMonths: 1,
}

export const QUOTE: TerminationQuoteData = {
  ...BASE, quoteId: "quote-1", status: "ACCEPTED", quotedOn: "2027-02-23", terminationDate: "2027-03-15", validUntil: "2027-03-05",
  cpaCancellation: true, remainingRentals: 14, pvCents: 41_234_567, penaltyCents: 0, goodsValueCents: 12_000_000, documentedCosts: [{ description: "Recovery", amountCents: 500_000, evidence: "synthetic-recovery.pdf" }], arrearsCents: 1_234_500,
  invoiceExclVatCents: 29_734_567, invoiceVatCents: 4_460_185, totalCents: 35_429_252, basis: BASIS,
}

export const REPORT: InspectionReportData = {
  ...BASE, endOfTermId: "eot-1", origin: "EXPIRY", outcome: "RETURN", inspectedOn: "2027-07-02",
  condition: "Good, with wear to the bucket teeth and a cracked side mirror",
  startReading: { value: 120, date: "2024-07-01", unit: "HOURS" },
  finalReading: { value: 4_620, date: "2027-07-02", unit: "HOURS" },
  damage: [
    { description: "Replace cracked side mirror", amountExclVatCents: 123_456 },
    { description: "Repair dented left door", amountExclVatCents: 765_432 },
  ],
  excessUsageCents: 1_750_000,
}

/** The loan relation every loader selects, as Prisma returns it. */
export const LOAN_ROW = {
  id: "loan-1",
  reference: "TEST-LSE-0001",
  entity: { legalName: "TEST Lessee Holdings", registrationNumber: "2020/000001/07" },
  client: null,
  asset: { make: "Testmake", model: "Loader 9000", year: 2025, serialNumber: "SN-TEST-001" },
}

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`)

export const NOTICE_ROW = { id: "notice-1", expiryDate: day("2027-06-30"), queuedOn: day("2027-02-01"), loan: LOAN_ROW }

export const QUOTE_ROW = {
  id: "quote-1", status: "ACCEPTED", quotedOn: day("2027-02-23"), terminationDate: day("2027-03-15"), validUntil: day("2027-03-05"),
  cpaCancellation: true, remainingRentals: 14, pvCents: 41_234_567, penaltyCents: 0, goodsValueCents: 12_000_000, documentedCosts: [{ description: "Recovery", amountCents: 500_000, evidence: "synthetic-recovery.pdf" }], arrearsCents: 1_234_500,
  invoiceExclVatCents: 29_734_567, invoiceVatCents: 4_460_185, totalCents: 35_429_252, basis: BASIS, loan: LOAN_ROW,
}

export const END_ROW = {
  id: "eot-1", origin: "EXPIRY", outcome: "RETURN", inspectedOn: day("2027-07-02"), inspectionCondition: REPORT.condition, excessUsageCents: 1_750_000,
  finalReading: { value: 4_620, readingDate: day("2027-07-02"), unit: "HOURS" },
  damageItems: REPORT.damage, loan: LOAN_ROW,
}

export const START_READING_ROW = { value: 120, readingDate: day("2024-07-01"), unit: "HOURS" }
