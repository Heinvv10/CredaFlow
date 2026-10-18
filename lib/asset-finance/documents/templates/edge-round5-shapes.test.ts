/**
 * Round-5 adversarial edge test of the shape-based protected-output
 * fingerprint. Lease and NCA agreements print the reference-rate LABEL
 * (deal-labels.ts RATE_BASIS_LABELS) in protected sentences, but their
 * preview shapes only use PRIME and FIXED. Every rate basis is allowed on
 * every deal (deal-input.ts RATE_BASES), so a lease or NCA deal on REPO,
 * JIBAR, ZARONIA or the lender's base rate prints protected wording no shape
 * reaches: it can change with no fingerprint change and no re-approval, and
 * no approver ever previews it (the LENDER_BASE lease sentence even reads
 * "the Lender base rate rate").
 *
 * DEFECT tests failed on feat/lender-owned-templates 3297f208; the shape
 * coverage is FIXED by per-rate-basis lease and NCA shapes. The grammar case
 * ("Lender base rate rate") is starter lease wording, which this work may not
 * rewrite: it stays an expected failure (it.fails) for the drafters, and turns
 * red here once the wording is corrected so this marker is removed.
 */
import { describe, expect, it } from "vitest"
import { leaseScheduleView } from "../../lease-view"
import { priceLease } from "../../lease-pricing"
import { renderNcaAssetAgreement } from "../nca/agreement-pdf"
import { prose, texts } from "../nca/nca-wording.test-helpers"
import type { NcaAssetDocumentData } from "../nca/types"
import type { LeaseDocumentTerms } from "../lease/lease-document-data"
import { renderDealDocument } from "../render"
import { syntheticDealDocumentData } from "../synthetic-deal.fixture"
import { starterContent } from "./content"
import { parseTemplateKey } from "./families"
import { previewShapes, renderTemplatePreview } from "./preview"

const LENDER = { legalName: "Shape Lender (Pty) Ltd", tradingName: "Shape Lender", companyRegNumber: "2000/000000/07", ncrNumber: "NCRCP00000", registeredOfficeLines: ["1 Shape Street", "Testville"] }
const flat = async (pdf: Buffer) => prose(await texts(pdf)).replace(/\s+/g, " ")
const wording = (key: string) => ({ templateKey: key, content: starterContent(parseTemplateKey(key)!), mark: "NONE" as const })
async function shapeTexts(key: string): Promise<string[]> {
  const out: string[] = []
  for (const shape of previewShapes(key)) out.push(await flat(await renderTemplatePreview(key, starterContent(parseTemplateKey(key)!), LENDER, shape.id)))
  return out
}

/** An operating lease (as preview.ts builds it), juristic, arrears. */
function operatingLease(cpa: boolean): LeaseDocumentTerms {
  const priced = priceLease({
    cashPriceExclVatCents: 150_000_000, residualCents: 30_000_000, periods: 36, rentalTiming: "ARREARS", escalationRate: "0.08",
    startDate: "2026-12-31", firstDueDate: "2027-01-31", ratePath: [{ effectiveDate: "2026-12-31", annualRate: 0.1175 }],
    maintenance: null, vatRateTenThousandths: 1500,
  })
  return {
    contractType: "OPERATING_LEASE",
    terms: { rentalTiming: "ARREARS", escalationRate: "0.08", earlyTerminationPenaltyRate: "0.1", maintenance: null, usage: null },
    schedule: leaseScheduleView(priced, "0.1500"), endDate: "2029-12-31",
    cpaApplies: cpa, cpaRule: cpa ? "CPA_JURISTIC_UNDER_THRESHOLD" : "CPA_JURISTIC_OVER_THRESHOLD",
  }
}

const NCA: NcaAssetDocumentData = {
  legalWordingApproved: false, reference: "AF-NCA-EDGE-5", documentDate: new Date("2026-10-13T08:00:00.000Z"), contractType: "INSTALMENT_SALE",
  lender: { legalName: LENDER.legalName, ncrNumber: LENDER.ncrNumber, registeredOfficeLines: LENDER.registeredOfficeLines },
  borrower: { name: "TEST Sole Proprietor", identityNumber: "0000000000000", addressLines: ["2 Synthetic Street", "Johannesburg"] },
  asset: { description: "TEST 2026 TLB", serialNumber: "TESTSERIAL0001" },
  pricing: {
    cashPriceCents: 1_725_000, depositCents: 225_000, principalCents: 1_500_000, annualRate: "0.0850", rateBasis: "REPO", rateMargin: "0.0125",
    reference: { effectiveDate: "2026-09-01", rate: "0.0725" },
    initiationFeeCents: 120_750, monthlyServiceFeeCents: 6_000, creditLifePremiumCents: 0, instalmentCents: 140_000, balloonCents: 300_000,
    totalInterestCents: 172_500, totalCostOfCreditCents: 1_873_250, totalRepayableCents: 1_873_250,
  },
  schedule: [
    { installmentNo: 1, dueDate: "2026-11-30", principalCents: 100_000, interestCents: 14_000, feesCents: 13_500, totalCents: 127_500, closingBalanceCents: 1_400_000 },
    { installmentNo: 2, dueDate: "2026-12-31", principalCents: 1_400_000, interestCents: 13_000, feesCents: 13_500, totalCents: 1_426_500, closingBalanceCents: 0 },
  ],
}

describe("FIXED: rate-basis wording on leases and NCA agreements is reached by a preview shape", () => {
  it.each([
    ["LENDER_BASE", "linked to the Lender base rate rate"],
    ["JIBAR", "linked to the JIBAR rate"],
    ["REPO", "linked to the Repo rate"],
  ] as const)("af.lease.operating.commercial on %s prints %j", async (basis, sentence) => {
    const key = "af.lease.operating.commercial"
    const base = syntheticDealDocumentData({ lender: LENDER })
    const data = { ...base, pricing: { ...base.pricing, rateBasis: basis }, lease: operatingLease(false) }
    expect(await flat((await renderDealDocument(data, "AGREEMENT", "", wording(key))).bytes)).toContain(sentence)
    expect((await shapeTexts(key)).some((t) => t.includes(sentence)), `${sentence} is in no shape`).toBe(true)
  }, 60_000)

  it("af.nca.instalment_sale on REPO prints a variable-rate sentence no shape reaches", async () => {
    const key = "af.nca.instalment_sale"
    const sentence = "it is linked to Repo, and when Repo changes"
    expect(await flat(await renderNcaAssetAgreement(NCA, wording(key)))).toContain(sentence)
    expect((await shapeTexts(key)).some((t) => t.includes(sentence)), `${sentence} is in no shape`).toBe(true)
  }, 60_000)

  // KNOWN STARTER WORDING ISSUE (not fixed here): see docs/asset-finance/legal-wording/README.md.
  it.fails("the lease's protected rate sentence is grammatical for every allowed basis", async () => {
    const key = "af.lease.operating.commercial"
    const base = syntheticDealDocumentData({ lender: LENDER })
    const data = { ...base, pricing: { ...base.pricing, rateBasis: "LENDER_BASE" as const }, lease: operatingLease(false) }
    expect(await flat((await renderDealDocument(data, "AGREEMENT", "", wording(key))).bytes)).not.toContain("rate rate")
  }, 60_000)
})
