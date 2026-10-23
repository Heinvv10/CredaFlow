// Shared by the commission disclosure suites (commission-disclosure.test.ts,
// commission-disclosure-templates.test.ts): the nine render paths, the exact
// wording each must print, and helpers to take the disclosure out of a
// rendered document. Not a test file.
import { priceLease } from "../lease-pricing"
import { leaseScheduleView } from "../lease-view"
import { renderInstalmentSaleAgreement } from "./agreement-pdf"
import type { AnyDealDocumentData } from "./deal-document-data"
import { renderLeaseAgreement } from "./lease/agreement-pdf"
import type { LeaseDocumentTerms } from "./lease/lease-document-data"
import { renderNcaAssetAgreement } from "./nca/agreement-pdf"
import { prose } from "./nca/nca-wording.test-helpers"
import { renderNcaAssetQuote } from "./nca/quote-pdf"
import type { NcaAssetDocumentData } from "./nca/types"
import { syntheticDealDocumentData } from "./synthetic-deal"
import type { DocumentDealer } from "./wording/dealer-name"

export const DEALER: DocumentDealer = { name: "SAMPLE Dealer Motors (synthetic)", kind: "DEALER" }
export const SECTION = "COMMISSION TO THE INTRODUCER"

// The exact wording (goal §2a 2, SA-legal review round 1). Nothing in it varies with the deal.
export const ISA_CLAUSE = "Introducer's commission. The Seller may pay a commission to the introducer named above, which introduced the Purchaser to the Seller for this Agreement. The Seller pays any commission from its own funds. It is not part of the cash price, the payments in the Schedule or any other amount the Purchaser pays or owes under this Agreement."
export const LEASE_CLAUSE = "Introducer's commission. The lessor may pay a commission to the introducer named above, which introduced the lessee to the lessor for this agreement. The lessor pays any commission from its own funds. It is not part of the rentals or any other amount the lessee pays or owes under this agreement."
export const NCA_CLAUSE = (what: string) => `The Credit Provider may pay a commission to the introducer named above, which introduced the Consumer to the Credit Provider for ${what}. The Credit Provider pays any commission from its own funds. It is not a fee or charge to the Consumer: it is not part of the cash price, the principal debt, the interest, the fees, the instalments or any other amount the Consumer pays or owes, and it is not included in the total cost of credit shown above.`

const MONEY = /R\s?-?[\d,]+\.\d{2}/g
/** Every printed figure, in order. */
export const money = (lines: string[]): string[] => prose(lines).match(MONEY) ?? []

const priced = (fml: boolean) => priceLease({
  cashPriceExclVatCents: 150_000_000, residualCents: 30_000_000, periods: 36, rentalTiming: "ARREARS", escalationRate: "0.08",
  startDate: "2026-12-31", firstDueDate: "2027-01-31", ratePath: [{ effectiveDate: "2026-12-31", annualRate: 0.1175 }],
  maintenance: fml ? { monthlyExclVatCents: 450_000, escalationRate: "0.065" } : null, vatRateTenThousandths: 1500,
})
export const leaseOf = (fml: boolean): LeaseDocumentTerms => ({
  contractType: fml ? "FULL_MAINTENANCE_LEASE" : "OPERATING_LEASE",
  terms: {
    rentalTiming: "ARREARS", escalationRate: "0.08", earlyTerminationPenaltyRate: "0.1",
    maintenance: fml ? { monthlyExclVatCents: 450_000, escalationRate: "0.065", riskModel: "LESSEE_SETTLED" } : null,
    usage: fml ? { allowancePerYear: 1_500, unit: "HOURS", excessRateCents: 35_000 } : null,
  },
  schedule: leaseScheduleView(priced(fml), "0.1500"), endDate: "2029-12-31", cpaApplies: false, cpaRule: "CPA_JURISTIC_OVER_THRESHOLD",
})

export const nca: NcaAssetDocumentData = {
  legalWordingApproved: false, reference: "AF-NCA-TEST-1", documentDate: new Date("2026-10-13T08:00:00.000Z"), contractType: "INSTALMENT_SALE",
  lender: { legalName: "TEST Credit Provider (Pty) Ltd", ncrNumber: "NCRCP00000", registeredOfficeLines: ["1 Test Road", "Johannesburg"] },
  borrower: { name: "TEST Consumer", identityNumber: "0000000000000", addressLines: ["2 Synthetic Street", "Johannesburg"] },
  asset: { description: "TEST 2026 TLB", serialNumber: "TESTSERIAL0001" },
  pricing: {
    cashPriceCents: 1_725_000, depositCents: 225_000, principalCents: 1_500_000, annualRate: "0.1175",
    rateBasis: "FIXED", rateMargin: null, reference: null,
    initiationFeeCents: 120_750, monthlyServiceFeeCents: 6_000, creditLifePremiumCents: 7_500,
    instalmentCents: 140_000, balloonCents: 300_000, totalInterestCents: 172_500,
    totalCostOfCreditCents: 1_873_250, totalRepayableCents: 1_873_250,
  },
  schedule: [
    { installmentNo: 1, dueDate: "2026-11-30", principalCents: 100_000, interestCents: 14_000, feesCents: 13_500, totalCents: 127_500, closingBalanceCents: 1_400_000 },
    { installmentNo: 2, dueDate: "2026-12-31", principalCents: 1_400_000, interestCents: 13_000, feesCents: 13_500, totalCents: 1_426_500, closingBalanceCents: 0 },
  ],
}

export interface Case {
  name: string
  /** The disclosure paragraph as printed (with its lead-in on a contract). */
  clause: string
  /** A section of its own heads the disclosure (the NCA documents); otherwise it ends the price section. */
  heading: string | null
  /** The text that precedes the disclosure and the text that follows it, in print order. */
  between: [string, string]
  render: (dealer: DocumentDealer | null | undefined) => Promise<Buffer>
}
type Render = (data: never) => Promise<Buffer>
const withDealer = <T extends object>(data: T, dealer: DocumentDealer | null | undefined): T => ({ ...data, ...(dealer === undefined ? {} : { dealer }) })
const dealCase = (name: string, clause: string, data: AnyDealDocumentData, render: Render, between: [string, string]): Case => ({
  name, clause, heading: null, between, render: (dealer) => render(withDealer(data, dealer) as never),
})
const isa = (cpa: boolean) => syntheticDealDocumentData({ isaCpaApplies: cpa })
const lease = (fml: boolean, cpa: boolean): AnyDealDocumentData => ({ ...syntheticDealDocumentData(), lease: { ...leaseOf(fml), cpaApplies: cpa } })
const ISA_BETWEEN: [string, string] = ["5. PRICE AND FINANCE", "6. REPAYMENT SCHEDULE"]
const LEASE_BETWEEN: [string, string] = ["5. RENTALS", "6. RENTAL SCHEDULE"]

export const CASES: Case[] = [
  dealCase("commercial instalment sale", ISA_CLAUSE, isa(false), renderInstalmentSaleAgreement as Render, ISA_BETWEEN),
  dealCase("CPA instalment sale", ISA_CLAUSE, isa(true), renderInstalmentSaleAgreement as Render, ISA_BETWEEN),
  dealCase("operating lease", LEASE_CLAUSE, lease(false, false), renderLeaseAgreement as Render, LEASE_BETWEEN),
  dealCase("full-maintenance lease", LEASE_CLAUSE, lease(true, false), renderLeaseAgreement as Render, LEASE_BETWEEN),
  dealCase("CPA operating lease", LEASE_CLAUSE, lease(false, true), renderLeaseAgreement as Render, LEASE_BETWEEN),
  dealCase("CPA full-maintenance lease", LEASE_CLAUSE, lease(true, true), renderLeaseAgreement as Render, LEASE_BETWEEN),
  {
    name: "NCA instalment sale agreement", clause: NCA_CLAUSE("this agreement"), heading: SECTION, between: ["FINANCIAL TERMS", "TERMS AND CONDITIONS"],
    render: (dealer) => renderNcaAssetAgreement(withDealer(nca, dealer)),
  },
  {
    name: "NCA finance lease agreement", clause: NCA_CLAUSE("this agreement"), heading: SECTION, between: ["FINANCIAL TERMS", "TERMS AND CONDITIONS"],
    render: (dealer) => renderNcaAssetAgreement(withDealer({ ...nca, contractType: "FINANCE_LEASE" as const }, dealer)),
  },
  {
    name: "NCA quotation", clause: NCA_CLAUSE("the proposed agreement"), heading: SECTION, between: ["PROPOSED REPAYMENT SCHEDULE", "ACKNOWLEDGEMENT"],
    render: (dealer) => renderNcaAssetQuote(withDealer(nca, dealer)),
  },
]

/** The introducer row as printed: label, then "<name> (dealer|broker)". */
export const introducerRow = (dealer: DocumentDealer) => `Introducer ${dealer.name} (${dealer.kind === "BROKER" ? "broker" : "dealer"})`

const TABLE_HEADER = /^(?:No\.|Due date|Payment|Interest|Capital|Fees|Balloon|Balance|Rental excl\. VAT|Maintenance|VAT|Total incl\. VAT)$/

/**
 * The lines without the page furniture ("Page 1 of 2", "Ref ...", the DRAFT mark) and without the title and
 * column headers a table repeats when a page break falls inside it: the longer document breaks pages elsewhere.
 */
export function body(lines: string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < lines.length; i++) {
    if (/^Page \d+ of \d+$|^Ref |^DRAFT — /.test(lines[i])) continue
    if (lines[i].endsWith("(continued)")) {
      while (TABLE_HEADER.test(lines[i + 1] ?? "")) i++
      continue
    }
    out.push(lines[i])
  }
  return out
}

/** The printed text without page furniture, wrapped lines rejoined, whitespace collapsed. */
export const printed = (lines: string[]): string => prose(body(lines)).replace(/\s+/g, " ")

/** `lines` printed with the introducer row, its section heading and the paragraph taken out. */
export function withoutDisclosure(lines: string[], dealer: DocumentDealer, clause: string, heading: string | null): string {
  return printed(lines).replace(`${heading ? `${heading} ` : ""}${introducerRow(dealer)} ${clause}`, "").replace(/\s+/g, " ")
}
