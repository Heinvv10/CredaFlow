// Synthetic data for the lease servicing document tests (slice 3, C9): the
// renderer inputs and the database rows the loaders read. Obviously fake.
import { cpaCancellationCharge, cpaCancellationDate, earlyTerminationAmount } from "@/lib/asset-finance/lease-termination"
import { vatOnExclusive } from "@/lib/vat/amounts"
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

// Shared synthetic cash flows make both quotes reproducible from their dates.
export const QUOTE_RENTALS = Array.from({ length: 14 }, (_, i) => ({
  dueDate: `${2027 + Math.floor((i + 3) / 12)}-${String((i + 3) % 12 + 1).padStart(2, "0")}-15`,
  rentalExclVatCents: 3_000_000,
}))
const quotedOn = "2027-02-23"
const terminationDate = cpaCancellationDate(quotedOn)
const documentedCosts = [{ description: "Recovery", amountCents: 500_000, evidence: "synthetic-recovery.pdf", valuationNoOverlapEvidence: "synthetic-net-valuation-excludes-this-cost.pdf" }]
const cpa = cpaCancellationCharge({ rentals: QUOTE_RENTALS, terminationDate, annualRate: 0.12, goodsValueCents: 12_000_000, costs: documentedCosts })
const arrearsCents = 1_234_500
const invoiceVatCents = vatOnExclusive(cpa.chargeCents, 1500)
export const QUOTE: TerminationQuoteData = {
  ...BASE, quoteId: "quote-1", status: "ACCEPTED", quotedOn, terminationDate, validUntil: "2027-03-05",
  cpaCancellation: true, remainingRentals: QUOTE_RENTALS.filter(r => r.dueDate > terminationDate).length,
  pvCents: cpa.pvCents, penaltyCents: 0, goodsValueCents: cpa.goodsValueCents, documentedCosts, arrearsCents,
  invoiceExclVatCents: cpa.chargeCents, invoiceVatCents, totalCents: cpa.chargeCents + invoiceVatCents + arrearsCents, basis: BASIS,
}
export const COMMERCIAL_QUOTE: TerminationQuoteData = {
  ...QUOTE, status: "QUOTED", cpaCancellation: false, goodsValueCents: null, documentedCosts: [], terminationDate: quotedOn,
  ...earlyTerminationAmount({ rentals: QUOTE_RENTALS, terminationDate: quotedOn, annualRate: 0.12, arrearsCents, penaltyRate: "0.1", vatRateTenThousandths: 1500 }),
  basis: "Present value of the rentals (ex VAT and maintenance) falling due after 2027-02-23, discounted at the contract rate, plus a penalty of 10.00% of that present value, plus the arrears. The asset is returned; no credit is given for its resale value.",
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
  id: QUOTE.quoteId, status: QUOTE.status, cpaCancellation: QUOTE.cpaCancellation,
  remainingRentals: QUOTE.remainingRentals, pvCents: QUOTE.pvCents, penaltyCents: QUOTE.penaltyCents,
  goodsValueCents: QUOTE.goodsValueCents, documentedCosts: QUOTE.documentedCosts, arrearsCents: QUOTE.arrearsCents,
  invoiceExclVatCents: QUOTE.invoiceExclVatCents, invoiceVatCents: QUOTE.invoiceVatCents, totalCents: QUOTE.totalCents, basis: QUOTE.basis,
  quotedOn: day(QUOTE.quotedOn), terminationDate: day(QUOTE.terminationDate), validUntil: day(QUOTE.validUntil), loan: LOAN_ROW,
}

export const END_ROW = {
  id: "eot-1", origin: "EXPIRY", outcome: "RETURN", inspectedOn: day("2027-07-02"), inspectionCondition: REPORT.condition, excessUsageCents: 1_750_000,
  finalReading: { value: 4_620, readingDate: day("2027-07-02"), unit: "HOURS" },
  damageItems: REPORT.damage, loan: LOAN_ROW,
}

export const START_READING_ROW = { value: 120, readingDate: day("2024-07-01"), unit: "HOURS" }
