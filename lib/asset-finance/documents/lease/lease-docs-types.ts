// The data the three lease servicing documents print (slice 3, C9): the CPA
// expiry notice, the early-termination quote and the end-of-term inspection
// report. Read from the database rows by ./lease-docs-loader.ts; rendered by
// the *-pdf.ts files beside it. Dates are ISO calendar days, money integer cents.
import type { LenderIdentity } from "@/lib/config/identity-schema"

/** The part of the tenant's identity a lease document prints (the letterhead and the contacts). */
export type LeaseDocLender = Pick<
  LenderIdentity,
  "legalName" | "tradingName" | "registeredOfficeLines" | "publicEmail" | "publicPhone" | "collectionsEmail" | "collectionsPhone"
>

export interface LeaseDocBase {
  loanId: string
  reference: string
  lessee: string
  asset: string
  /** True until TenantConfig.assetFinanceLegalWordingApproved: the DRAFT watermark goes on every page. */
  draft: boolean
  /** The lessee is a natural person: CPA s14 applies by statute (a juristic CPA lessee has the same terms by contract). */
  naturalPerson: boolean
}

export interface ExpiryNoticeData extends LeaseDocBase {
  noticeId: string
  /** The day the fixed term expires. */
  expiryDate: string
  /** The day the daily lease run queued the notice. */
  queuedOn: string
  /** Notice either party gives to end a month-to-month extension. */
  extensionNoticeMonths: number
}

export interface TerminationQuoteData extends LeaseDocBase {
  quoteId: string
  status: "QUOTED" | "ACCEPTED"
  quotedOn: string
  terminationDate: string
  validUntil: string
  cpaCancellation: boolean
  remainingRentals: number
  pvCents: number
  penaltyCents: number
  arrearsCents: number
  invoiceExclVatCents: number
  invoiceVatCents: number
  totalCents: number
  /** The formula and, for a CPA lessee, the Reg 5(2) wording, printed verbatim. */
  basis: string
}

export interface InspectionReading {
  value: number
  date: string
  unit: "HOURS" | "KM"
}

/** A meter reading row as the loader selects it. */
export interface InspectionReadingRow {
  value: number
  readingDate: Date
  unit: "HOURS" | "KM"
}

export interface InspectionReportData extends LeaseDocBase {
  endOfTermId: string
  origin: "EXPIRY" | "EARLY_TERMINATION"
  outcome: string
  inspectedOn: string
  condition: string
  startReading: InspectionReading | null
  finalReading: InspectionReading | null
  damage: { description: string; amountExclVatCents: number }[]
  /** Set once the end-of-term invoice is issued; null before. */
  excessUsageCents: number | null
}
