import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import { renderNcaAssetAgreement } from "./agreement-pdf"
import { expectDraftMarks, expectWordedClauses, prose, texts } from "./nca-wording.test-helpers"
import { renderNcaAssetQuote } from "./quote-pdf"
import type { NcaAssetDocumentData } from "./types"

const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex")

const data: NcaAssetDocumentData = {
  legalWordingApproved: false,
  reference: "AF-NCA-TEST-1", documentDate: new Date("2026-10-13T08:00:00.000Z"), contractType: "FINANCE_LEASE",
  lender: { legalName: "TEST Credit Provider (Pty) Ltd", ncrNumber: "NCRCP00000", registeredOfficeLines: ["1 Test Road", "Johannesburg"] },
  borrower: { name: "TEST Sole Proprietor", identityNumber: "0000000000000", addressLines: ["2 Synthetic Street", "Johannesburg"] },
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
const prime: NcaAssetDocumentData = {
  ...data, contractType: "INSTALMENT_SALE",
  pricing: { ...data.pricing, rateBasis: "PRIME", rateMargin: "0.0125", reference: { effectiveDate: "2026-09-01", rate: "0.105" } },
}

const AGREEMENT_HEADINGS = [
  "Interpretation", "Delivery, possession, risk and ownership", "Payments, interest and statutory charges",
  "Insurance and credit-life election", "Consumer statements and early settlement", "Default, enforcement and statutory notices",
  "Voluntary surrender", "Cooling-off right", "Credit information, debt review and complaints", "Addresses and notices", "General",
]

describe("asset-finance NCA documents", () => {
  it.each([renderNcaAssetQuote, renderNcaAssetAgreement])("is deterministic and prints the real figures", async (render) => {
    const first = await render(data)
    expect(sha(first)).toBe(sha(await render({ ...data })))
    const all = await texts(first)
    expect(all).toEqual(expect.arrayContaining(["TEST Sole Proprietor", "R 15,000.00", "R 18,732.50"]))
    expect(prose(all)).toContain("TESTSERIAL0001")
  })

  it.each([renderNcaAssetQuote, renderNcaAssetAgreement])("keeps the DRAFT watermark and subtitle until the lender's legal wording is approved", async (render) => {
    expectDraftMarks(await texts(await render(data)), false)
    expectDraftMarks(await texts(await render({ ...data, legalWordingApproved: true })), true)
  })

  it("prints cash price, deposit and credit-life on the agreement", async () => {
    const all = await texts(await renderNcaAssetAgreement(data))
    expect(all).toEqual(expect.arrayContaining(["Cash price", "R 17,250.00", "Deposit", "R 2,250.00", "Credit-life premium", "R 75.00"]))
  })

  it.each([renderNcaAssetQuote, renderNcaAssetAgreement])("discloses the inclusive total cost once", async (render) => {
    const all = await texts(await render(data))
    expect(all).toContain("Total cost of credit")
    expect(all).not.toContain("Total repayable")
  })

  it("renders agreement-specific titles with the same real figures", async () => {
    expect(await texts(await renderNcaAssetAgreement(data))).toContain("NCA FINANCE LEASE AGREEMENT")
    expect(await texts(await renderNcaAssetAgreement({ ...data, contractType: "INSTALMENT_SALE" }))).toContain("NCA INSTALMENT SALE AGREEMENT")
  })
})

describe("NCA agreement wording", () => {
  it("prints every clause with wording, no placeholder", async () => {
    expectWordedClauses(await texts(await renderNcaAssetAgreement(data)), AGREEMENT_HEADINGS)
  })

  it("names the parties, the goods and the deal's figures and dates", async () => {
    const all = prose(await texts(await renderNcaAssetAgreement(data)))
    expect(all).toContain('"the Credit Provider" means TEST Credit Provider (Pty) Ltd, registered credit provider NCRCP00000')
    expect(all).toContain('"the Consumer" means TEST Sole Proprietor')
    expect(all).toContain("the TEST 2026 TLB, serial or VIN number TESTSERIAL0001")
    expect(all).toContain("This agreement is a lease as defined in section 1 of the Act and an intermediate agreement")
    expect(all).toContain("must pay 2 monthly instalments")
    expect(all).toContain("the first on 30 November 2026 and the last on 31 December 2026")
    expect(all).toContain("residual (balloon) amount of R 3,000.00")
    expect(all).toContain("Fixed at 11.75% a year (nominal)")
    expect(all).toContain("The rate is fixed for the whole term")
    expect(all).toContain("credit-life cover at a premium of R 75.00 a month")
    expect(all).toContain("No early-termination charge is payable.")
    expect(all).toContain("2 Synthetic Street, Johannesburg")
    expect(all).toContain("6.5 At any time before the Credit Provider has cancelled this agreement, the Consumer may remedy a default by paying all overdue amounts")
    expect(all).toContain("up to the time the default is remedied, as section 129(3) of the Act provides")
    expect(all).not.toMatch(/reinstate/i)
    expect(all).toContain("If the Goods are already in the Credit Provider's possession, the Consumer may in that notice require the Credit Provider to sell them, "
      + "as section 127(1)(b)(i) of the Act provides.")
  })

  it("follows the contract type, the rate basis, the size and the credit-life election", async () => {
    const all = prose(await texts(await renderNcaAssetAgreement({
      ...prime, pricing: { ...prime.pricing, principalCents: 25_000_000, creditLifePremiumCents: 0 },
    })))
    expect(all).toContain("This agreement is an instalment agreement as defined in section 1 of the Act and a large agreement")
    expect(all).toContain("The Credit Provider sells the Goods")
    expect(all).toContain("Prime plus 1.25%")
    expect(all).toContain("The rate is variable: it is linked to Prime")
    expect(all).toContain("still ends on 31 December 2026")
    expect(all).toContain("No credit-life premium is payable under this agreement.")
    expect(all).toContain("may also charge an early-termination charge")
    expect(all).not.toContain("The rate is fixed")
  })
})

describe("NCA quotation wording", () => {
  it("prints its clause with wording, no placeholder", async () => {
    expectWordedClauses(await texts(await renderNcaAssetQuote(data)), ["Statutory disclosures and validity period"])
  })

  it("states the validity period, the parties and the deal's cost of credit", async () => {
    const all = prose(await texts(await renderNcaAssetQuote(data)))
    expect(all).toContain('"the Credit Provider" means TEST Credit Provider (Pty) Ltd, registered credit provider NCRCP00000')
    expect(all).toContain("bound by this quotation for five business days")
    expect(all).toContain("The total cost of credit of R 18,732.50 shown above is the principal debt together with the interest")
    expect(all).toContain("the total repayable is R 18,732.50")
    expect(all).toContain("credit-life cover at R 75.00 a month")
    expect(all).toContain("and the premium of any insurance the Credit Provider arranges under section 106 of the Act if the Consumer does not keep the asset insured")
    expect(all).not.toContain("Because the proposed rate is variable")
    expect(prose(await texts(await renderNcaAssetQuote(prime)))).toContain("Because the proposed rate is variable")
  })
})
