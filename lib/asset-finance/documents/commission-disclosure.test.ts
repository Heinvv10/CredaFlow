// The dealer commission disclosure (slice 5 follow-ups, part W, goal §2a 2):
// a protected, unnumbered paragraph printed only on a dealer deal, never a
// figure. Docs: docs/asset-finance/SLICE5-FOLLOWUPS.md "Part W".
import { describe, expect, it } from "vitest"
import { priceLease } from "../lease-pricing"
import { leaseScheduleView } from "../lease-view"
import { renderInstalmentSaleAgreement } from "./agreement-pdf"
import type { AnyDealDocumentData } from "./deal-document-data"
import { renderLeaseAgreement } from "./lease/agreement-pdf"
import type { LeaseDocumentTerms } from "./lease/lease-document-data"
import { renderNcaAssetAgreement } from "./nca/agreement-pdf"
import { prose, texts } from "./nca/nca-wording.test-helpers"
import { renderNcaAssetQuote } from "./nca/quote-pdf"
import type { NcaAssetDocumentData } from "./nca/types"
import { syntheticDealDocumentData } from "./synthetic-deal"
import { starterContent } from "./templates/content"
import { ALL_TEMPLATE_KEYS, parseTemplateKey } from "./templates/families"
import { previewShapes, renderTemplatePreview } from "./templates/preview"
import { contentProblems } from "./templates/validate"
import { commissionDisclosure, type CommissionDocument } from "./wording/commission-disclosure"

const DEALER = { name: "SAMPLE Dealer Motors (synthetic)" }
// Every figure the documents print: "R 1,234.56".
const MONEY = /R\s?-?[\d,]+\.\d{2}/g
const money = (lines: string[]) => prose(lines).match(MONEY) ?? []

const ISA_CLAUSE = `Dealer commission. The Seller may pay a commission to ${DEALER.name}, the dealer that introduced this Agreement. The Seller pays any commission from its own funds. It is not part of the cash price, the payments in the Schedule or any other amount the Purchaser pays or owes under this Agreement, and it does not increase any of them.`
const LEASE_CLAUSE = `Dealer commission. The lessor may pay a commission to ${DEALER.name}, the dealer that introduced this agreement. The lessor pays any commission from its own funds. It is not part of the rentals or any other amount the lessee pays or owes under this agreement, and it does not increase any of them.`
const NCA_CLAUSE = (what: string) => `Dealer commission. The Credit Provider may pay a commission to ${DEALER.name}, the dealer that introduced ${what}. The Credit Provider pays any commission from its own funds. It is not charged to the Consumer: it is not part of the cash price, the principal debt, the interest, the fees, the instalments or any other amount the Consumer pays or owes, and it is not part of the total cost of credit shown above.`

const priced = (fml: boolean) => priceLease({
  cashPriceExclVatCents: 150_000_000, residualCents: 30_000_000, periods: 36, rentalTiming: "ARREARS", escalationRate: "0.08",
  startDate: "2026-12-31", firstDueDate: "2027-01-31", ratePath: [{ effectiveDate: "2026-12-31", annualRate: 0.1175 }],
  maintenance: fml ? { monthlyExclVatCents: 450_000, escalationRate: "0.065" } : null, vatRateTenThousandths: 1500,
})
const leaseOf = (fml: boolean): LeaseDocumentTerms => ({
  contractType: fml ? "FULL_MAINTENANCE_LEASE" : "OPERATING_LEASE",
  terms: {
    rentalTiming: "ARREARS", escalationRate: "0.08", earlyTerminationPenaltyRate: "0.1",
    maintenance: fml ? { monthlyExclVatCents: 450_000, escalationRate: "0.065", riskModel: "LESSEE_SETTLED" } : null,
    usage: fml ? { allowancePerYear: 1_500, unit: "HOURS", excessRateCents: 35_000 } : null,
  },
  schedule: leaseScheduleView(priced(fml), "0.1500"), endDate: "2029-12-31", cpaApplies: false, cpaRule: "CPA_JURISTIC_OVER_THRESHOLD",
})

const nca: NcaAssetDocumentData = {
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

interface Case {
  name: string
  clause: string
  render: (dealer: { name: string } | null | undefined) => Promise<Buffer>
}
const dealCase = (name: string, clause: string, data: AnyDealDocumentData, render: (d: never) => Promise<Buffer>): Case => ({
  name, clause, render: (dealer) => render({ ...data, ...(dealer === undefined ? {} : { dealer }) } as never),
})
const isa = (cpa: boolean) => syntheticDealDocumentData({ isaCpaApplies: cpa })
const lease = (fml: boolean, cpa: boolean): AnyDealDocumentData => ({ ...syntheticDealDocumentData(), lease: { ...leaseOf(fml), cpaApplies: cpa } })

const CASES: Case[] = [
  dealCase("commercial instalment sale", ISA_CLAUSE, isa(false), renderInstalmentSaleAgreement as never),
  dealCase("CPA instalment sale", ISA_CLAUSE, isa(true), renderInstalmentSaleAgreement as never),
  dealCase("operating lease", LEASE_CLAUSE, lease(false, false), renderLeaseAgreement as never),
  dealCase("full-maintenance lease", LEASE_CLAUSE, lease(true, false), renderLeaseAgreement as never),
  dealCase("CPA operating lease", LEASE_CLAUSE, lease(false, true), renderLeaseAgreement as never),
  dealCase("CPA full-maintenance lease", LEASE_CLAUSE, lease(true, true), renderLeaseAgreement as never),
  { name: "NCA instalment sale agreement", clause: NCA_CLAUSE("this agreement to the Credit Provider"), render: (dealer) => renderNcaAssetAgreement({ ...nca, ...(dealer === undefined ? {} : { dealer }) }) },
  { name: "NCA finance lease agreement", clause: NCA_CLAUSE("this agreement to the Credit Provider"), render: (dealer) => renderNcaAssetAgreement({ ...nca, contractType: "FINANCE_LEASE", ...(dealer === undefined ? {} : { dealer }) }) },
  { name: "NCA quotation", clause: NCA_CLAUSE("the proposed agreement to the Credit Provider"), render: (dealer) => renderNcaAssetQuote({ ...nca, ...(dealer === undefined ? {} : { dealer }) }) },
]

describe("dealer commission disclosure", () => {
  describe.each(CASES)("$name", ({ clause, render }) => {
    it("prints the clause, naming the dealer, on a dealer deal", async () => {
      expect(prose(await texts(await render(DEALER)))).toContain(clause)
    })

    it.each([null, undefined])("prints nothing on a deal without a dealer (%s)", async (none) => {
      const text = prose(await texts(await render(none)))
      // (A lease's remedies already mention "collection commission": the disclosure is what must not print.)
      expect(text).not.toContain("Dealer commission")
      expect(text).not.toContain("the dealer that introduced")
    })

    it("a deal with no dealer renders byte-identical to the document before the clause existed (dealer null, absent)", async () => {
      expect((await render(null)).equals(await render(undefined))).toBe(true)
    })

    it("changes no figure: the money is the same, in the same order, and nothing else differs", async () => {
      const without = await texts(await render(null))
      const withDealer = await texts(await render(DEALER))
      expect(money(withDealer)).toEqual(money(without))
      expect(money(without).length).toBeGreaterThan(5)
      // Page furniture (the page count, the watermark per page) moves with the length: the body does not.
      expect(body(withoutClause(body(withDealer), clause))).toEqual(body(without))
    })
  })

  it("an NCA document never moves a cost-of-credit line or sentence for a dealer deal", async () => {
    for (const render of [renderNcaAssetQuote, renderNcaAssetAgreement]) {
      const before = await texts(await render(nca))
      const after = await texts(await render({ ...nca, dealer: DEALER }))
      for (const lines of [before, after]) {
        const at = lines.indexOf("Total cost of credit")
        expect(lines[at + 1]).toBe("R 18,732.50")
      }
      const dealerClause = NCA_CLAUSE(render === renderNcaAssetQuote ? "the proposed agreement to the Credit Provider" : "this agreement to the Credit Provider")
      const cost = (lines: string[]) => prose(lines).replace(dealerClause, "").match(/[^.]*(?:cost of credit|total repayable)[^.]*\./gi)
      expect(cost(after)).toEqual(cost(before))
      expect(cost(before)?.length).toBeGreaterThan(1)
    }
    expect(prose(await texts(await renderNcaAssetQuote({ ...nca, dealer: DEALER })))).toContain(
      "The total cost of credit of R 18,732.50 shown above is the principal debt together with the interest, the initiation fee, the monthly service fees and any credit-life premiums, and the total repayable is R 18,732.50.",
    )
  })

  it("prints for a sole-proprietor lease and a deal whose name has awkward characters", async () => {
    const sole: AnyDealDocumentData = {
      ...syntheticDealDocumentData(), entity: null, lease: leaseOf(false),
      soleProprietor: { clientId: "client-lessee", name: "TEST Soleprop", idNumber: "0000000000000", addressLines: ["3 Test Lane"] },
      signatories: [{ clientId: "client-lessee", name: "TEST Soleprop", idNumber: "0000000000000" }], sureties: [],
    }
    expect(prose(await texts(await renderLeaseAgreement({ ...sole, dealer: { name: "Dealer & Sons (Pty) Ltd" } })))).toContain("may pay a commission to Dealer & Sons (Pty) Ltd, the dealer")
  })
})

describe("lender text cannot carry a commission", () => {
  const LENDER_TEXT_VARIANTS = ["af.isa.commercial", "af.lease.operating.commercial", "af.lease.fml.commercial"]
  const attempts = [
    "The lessor may pay a commission to the dealer that introduced this agreement.",
    "A Commission of the dealer is for the lessor's account and is not part of the rentals.",
    "The dealer earns commissions on every deal the lender finances.",
  ]
  it.each(LENDER_TEXT_VARIANTS.flatMap((key) => attempts.map((text) => [key, text] as const)))("%s refuses an additional term that says %j", (key, text) => {
    const content = { ...starterContent(parseTemplateKey(key)!), additionalTerms: [{ heading: "Dealer arrangements", text }] }
    expect(contentProblems(key, content).map((p) => p.message).join(" ")).toMatch(/"[Cc]ommissions?"/)
  })

  it("refuses the word in an editable clause too, and the starter wording still validates", () => {
    const key = "af.isa.commercial"
    const starter = starterContent(parseTemplateKey(key)!)
    expect(contentProblems(key, starter)).toEqual([])
    const content = { ...starter, clauses: { ...starter.clauses, insurance: `${starter.clauses.insurance} The Seller pays a commission on the premium.` } }
    expect(contentProblems(key, content).map((p) => p.field)).toEqual(["clauses.insurance"])
  })
})

describe("template previews carry the disclosure in exactly one extra shape", () => {
  const lender = { legalName: "Shape Lender (Pty) Ltd", tradingName: "Shape", companyRegNumber: "2000/000000/07", ncrNumber: "NCRCP00000", registeredOfficeLines: ["1 Street", "Town"] }
  const DOCUMENT: Record<string, CommissionDocument | undefined> = {
    "af.isa.commercial": "INSTALMENT_SALE", "af.isa.cpa": "INSTALMENT_SALE",
    "af.lease.operating.commercial": "LEASE", "af.lease.operating.cpa": "LEASE", "af.lease.fml.commercial": "LEASE", "af.lease.fml.cpa": "LEASE",
    "af.nca.instalment_sale": "NCA_AGREEMENT", "af.nca.finance_lease": "NCA_AGREEMENT",
  }
  const printed = async (key: string, shape: string | undefined) => body(await texts(await renderTemplatePreview(key, starterContent(parseTemplateKey(key)!), lender, shape)))

  it.each(ALL_TEMPLATE_KEYS)("%s: only a dealer shape prints the clause, and it adds nothing else to the first shape", async (key) => {
    const document = DOCUMENT[key]
    const ids = previewShapes(key).map((s) => s.id)
    if (!document) {
      expect(ids).not.toContain("dealer")
      return
    }
    expect(ids.filter((id) => id === "dealer")).toHaveLength(1)
    const clause = commissionDisclosure(document, { name: "SAMPLE Dealer (synthetic)" })
    for (const id of ids) {
      expect(prose(await printed(key, id)).includes(clause), `${key} ${id}`).toBe(id === "dealer")
    }
    expect(withoutClause(await printed(key, "dealer"), clause)).toEqual(await printed(key, undefined))
  }, 30_000)
})

const TABLE_HEADER = /^(?:No\.|Due date|Payment|Interest|Capital|Fees|Balloon|Balance|Rental excl\. VAT|Maintenance|VAT|Total incl\. VAT)$/

/**
 * The lines without the page furniture ("Page 1 of 2", "Ref ...", the DRAFT mark) and without the title and
 * column headers a table repeats when a page break falls inside it: the longer document breaks pages elsewhere.
 */
function body(lines: string[]): string[] {
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

/** The printed lines without the clause's own wrapped lines (a contiguous run starting "Dealer commission."). */
function withoutClause(lines: string[], clause: string): string[] {
  const start = lines.findIndex((line) => line.startsWith("Dealer commission."))
  expect(start, "the clause prints").toBeGreaterThanOrEqual(0)
  let end = start
  while (end < lines.length && lines.slice(start, end + 1).join(" ") !== clause) end++
  expect(end, "the clause is a contiguous run of lines").toBeLessThan(lines.length)
  return [...lines.slice(0, start), ...lines.slice(end + 1)]
}
