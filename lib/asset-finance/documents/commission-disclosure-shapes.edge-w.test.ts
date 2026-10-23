// Edge tester W: sole-proprietor lease with a dealer; lender additional terms + dealer; page furniture.
import { describe, expect, it } from "vitest"
import { pdfPageContents } from "@/lib/pdf/__tests__/pdf-test-utils"
import { introducerRow, LEASE_CLAUSE, printed } from "./commission-disclosure.test-helpers"
import { syntheticDealDocumentData } from "./synthetic-deal"
import { leaseOf } from "./commission-disclosure.test-helpers"
import { renderLeaseAgreement } from "./lease/agreement-pdf"
import { texts } from "./nca/nca-wording.test-helpers"
import { starterContent } from "./templates/content"
import { parseTemplateKey } from "./templates/families"
import { previewShapes, renderTemplatePreview } from "./templates/preview"
import type { AnyDealDocumentData } from "./deal-document-data"

const DEALER = { name: "Société Müller & O'Brien (Pty) Ltd", kind: "DEALER" as const }
const sole = (cpa: boolean, fml: boolean): AnyDealDocumentData => ({
  ...syntheticDealDocumentData(), entity: null,
  soleProprietor: { clientId: "client-lessee", name: "Test Soleprop", idNumber: "0000000000000", addressLines: ["3 Test Lane", "Pretoria"] },
  signatories: [{ clientId: "client-lessee", name: "Test Soleprop", idNumber: "0000000000000" }], sureties: [],
  lease: { ...leaseOf(fml), cpaApplies: cpa, cpaRule: cpa ? "CPA_NATURAL_PERSON" : "CPA_JURISTIC_OVER_THRESHOLD" },
} as AnyDealDocumentData)

describe("edge-w sole-proprietor lease with a dealer", () => {
  it.each([[true, false], [true, true], [false, false]])("cpa=%s fml=%s prints the introducer and clause once, moves nothing", async (cpa, fml) => {
    const base = printed(await texts(await renderLeaseAgreement(sole(cpa, fml))))
    const withD = printed(await texts(await renderLeaseAgreement({ ...sole(cpa, fml), dealer: DEALER })))
    expect(withD.split(LEASE_CLAUSE).length - 1).toBe(1)
    expect(withD).toContain(introducerRow(DEALER))
    expect(withD.replace(`${introducerRow(DEALER)} ${LEASE_CLAUSE}`, "").replace(/\s+/g, " ")).toEqual(base)
  })
})

describe("edge-w lender additional terms with a dealer shape", () => {
  const lender = { legalName: "Shape Lender (Pty) Ltd", tradingName: "Shape", companyRegNumber: "2000/000000/07", ncrNumber: "NCRCP00000", registeredOfficeLines: ["1 Street", "Town"] }
  const keys = ["af.isa.commercial", "af.lease.operating.commercial", "af.lease.fml.commercial", "af.isa.cpa"]
  it.each(keys)("%s: lender clauses keep their numbers and the disclosure still prints", async (key) => {
    const content = { ...starterContent(parseTemplateKey(key)!), additionalTerms: [{ heading: "Site access", text: "The lessee gives access to the site on weekdays." }] }
    if (!previewShapes(key).some((s) => s.id === "dealer")) return
    const plain = printed(await texts(await renderTemplatePreview(key, content, lender, previewShapes(key)[0].id)))
    const dealer = printed(await texts(await renderTemplatePreview(key, content, lender, "dealer")))
    expect(dealer).toContain("Introducer")
    // Every numbered heading in the plain shape is present, identically numbered, in the dealer shape.
    const heads = plain.match(/\b\d{1,2}\.\d{1,2} [A-Z][a-z]+/g) ?? []
    expect(heads.length).toBeGreaterThan(5)
    for (const h of heads.slice(0, 40)) expect(dealer, h).toContain(h)
    expect(dealer).toContain("Site access")
    const pages = (await pdfPageContents(await renderTemplatePreview(key, content, lender, "dealer"))).length
    expect(pages).toBeGreaterThan(0)
  }, 30_000)
})
