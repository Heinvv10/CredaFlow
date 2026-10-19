/**
 * Round-6 sweep of the shape-based protected-output fingerprint. A lease
 * whose product's default-interest margin is zero (the same product setting
 * the ISA "below-reference" shape covers) prints protected lease wording
 * that no lease preview shape reaches: clause "default interest ... at the
 * contract rate, calculated daily" (wording/lease-agreement-end.ts
 * defaultInterest) and the schedule row "Contract rate (no added margin)"
 * (lease/agreement-pdf.ts). Lease shapes only have a positive margin or none.
 *
 * DEFECT tests failed on feat/lender-owned-templates ca54ed92 and pass since the lease
 * "fixed" shape carries a zero default-interest margin.
 */
import { describe, expect, it } from "vitest"
import { leaseScheduleView } from "../../lease-view"
import { priceLease } from "../../lease-pricing"
import { prose, texts } from "../nca/nca-wording.test-helpers"
import type { LeaseDocumentTerms } from "../lease/lease-document-data"
import { renderDealDocument } from "../render"
import { syntheticDealDocumentData } from "../synthetic-deal"
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

describe("FIXED: a lease with a zero default-interest margin prints protected wording no shape reaches", () => {
  it.each([
    ["af.lease.operating.commercial", false, "at the contract rate, calculated daily"],
    ["af.lease.operating.cpa", true, "at the contract rate, calculated daily"],
    ["af.lease.operating.commercial", false, "Contract rate (no added margin)"],
  ] as const)("%s (CPA %s) prints %j", async (key, cpa, sentence) => {
    const base = syntheticDealDocumentData({ lender: LENDER })
    const data = { ...base, pricing: { ...base.pricing, arrearsMarginRate: "0" }, lease: operatingLease(cpa) }
    expect(await flat((await renderDealDocument(data, "AGREEMENT", "", wording(key))).bytes)).toContain(sentence)
    expect((await shapeTexts(key)).some((t) => t.includes(sentence)), `${sentence} is in no shape`).toBe(true)
  }, 60_000)
})
