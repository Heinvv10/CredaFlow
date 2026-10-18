/**
 * Round-4 adversarial edge test of the shape-based protected-output
 * fingerprint (fingerprint.ts over preview.ts previewShapes). Each case is a
 * real deal the system issues from an approved version; the protected
 * sentence it prints appears in NO preview shape of that variant, so
 * CredaFlow can change that sentence without any fingerprint changing and
 * without the lender re-approving.
 *
 * DEFECT tests fail on feat/lender-owned-templates 1ca53233.
 */
import { describe, expect, it } from "vitest"
import { renderNcaAssetAgreement } from "../nca/agreement-pdf"
import { prose, texts } from "../nca/nca-wording.test-helpers"
import type { NcaAssetDocumentData } from "../nca/types"
import { renderDealDocument } from "../render"
import { syntheticDealDocumentData } from "../synthetic-deal.fixture"
import type { DealDocumentData } from "../deal-document-data"
import { starterContent } from "./content"
import { parseTemplateKey } from "./families"
import { previewShapes, renderTemplatePreview } from "./preview"

const LENDER = { legalName: "Shape Lender (Pty) Ltd", tradingName: "Shape Lender", companyRegNumber: "2000/000000/07", ncrNumber: "NCRCP00000", registeredOfficeLines: ["1 Shape Street", "Testville"] }
const flat = async (pdf: Buffer) => prose(await texts(pdf)).replace(/\s+/g, " ")
const wording = (key: string) => ({ templateKey: key, content: starterContent(parseTemplateKey(key)!), mark: "NONE" as const })

/** Every shape the variant previews and fingerprints, as text. */
async function shapeTexts(key: string): Promise<string[]> {
  const out: string[] = []
  for (const shape of previewShapes(key)) out.push(await flat(await renderTemplatePreview(key, starterContent(parseTemplateKey(key)!), LENDER, shape.id)))
  return out
}

const NCA_WITH_CREDIT_LIFE: NcaAssetDocumentData = {
  legalWordingApproved: false, reference: "AF-NCA-EDGE-1", documentDate: new Date("2026-10-13T08:00:00.000Z"), contractType: "FINANCE_LEASE",
  lender: { legalName: LENDER.legalName, ncrNumber: LENDER.ncrNumber, registeredOfficeLines: LENDER.registeredOfficeLines },
  borrower: { name: "TEST Sole Proprietor", identityNumber: "0000000000000", addressLines: ["2 Synthetic Street", "Johannesburg"] },
  asset: { description: "TEST 2026 TLB", serialNumber: "TESTSERIAL0001" },
  pricing: {
    cashPriceCents: 1_725_000, depositCents: 225_000, principalCents: 1_500_000, annualRate: "0.1175", rateBasis: "FIXED", rateMargin: null, reference: null,
    initiationFeeCents: 120_750, monthlyServiceFeeCents: 6_000, creditLifePremiumCents: 7_500, instalmentCents: 140_000, balloonCents: 300_000,
    totalInterestCents: 172_500, totalCostOfCreditCents: 1_873_250, totalRepayableCents: 1_873_250,
  },
  schedule: [
    { installmentNo: 1, dueDate: "2026-11-30", principalCents: 100_000, interestCents: 14_000, feesCents: 13_500, totalCents: 127_500, closingBalanceCents: 1_400_000 },
    { installmentNo: 2, dueDate: "2026-12-31", principalCents: 1_400_000, interestCents: 13_000, feesCents: 13_500, totalCents: 1_426_500, closingBalanceCents: 0 },
  ],
}

const base = () => syntheticDealDocumentData({ lender: LENDER })
const isa = (d: DealDocumentData): DealDocumentData => ({ ...d, isaCpaApplies: false })

describe("DEFECT: protected sentences that no preview shape (so no fingerprint) reaches", () => {
  it("af.nca.finance_lease: the credit-life clause 4.3 of a consumer who elected cover", async () => {
    const sentence = "The Consumer has elected credit-life cover"
    const key = "af.nca.finance_lease"
    expect(await flat(await renderNcaAssetAgreement(NCA_WITH_CREDIT_LIFE, wording(key)))).toContain(sentence)
    expect((await shapeTexts(key)).some((t) => t.includes(sentence)), `${sentence} is in no shape`).toBe(true)
  }, 60_000)

  it.each([
    ["a prime-minus margin", "The margin below the reference rate", (d: DealDocumentData) => ({ ...d, pricing: { ...d.pricing, rateMargin: "-0.0050" } })],
    ["a purchaser with no recorded address", "at the Purchaser's address notified to the Seller in writing", (d: DealDocumentData) => ({ ...d, entity: { ...d.entity, addressLines: [] } })],
    ["default interest at the contract rate (zero arrears margin)", "at the Contract Rate in force from time to time. Default interest", (d: DealDocumentData) => ({ ...d, pricing: { ...d.pricing, arrearsMarginRate: "0" } })],
  ] as const)("af.isa.commercial: %s", async (_name, sentence, shape) => {
    const key = "af.isa.commercial"
    const issued = await renderDealDocument(isa(shape(base())), "AGREEMENT", "", wording(key))
    expect(await flat(issued.bytes)).toContain(sentence)
    expect((await shapeTexts(key)).some((t) => t.includes(sentence)), `${sentence} is in no shape`).toBe(true)
  }, 60_000)
})
