import { describe, expect, it } from "vitest"
import { renderInstalmentSaleAgreement } from "../agreement-pdf"
import { prose, texts } from "../nca/nca-wording.test-helpers"
import { DRAFT_WATERMARK, SYNTHETIC_DEMO_WATERMARK } from "../pdf-layout"
import { syntheticDealDocumentData } from "../synthetic-deal"
import { canonicalContent, contentSha256, parseContent, starterContent, type AssetTemplateContent } from "./content"
import { ALL_TEMPLATE_KEYS, additionalTermNumber, parseTemplateKey, takesLenderText } from "./families"
import { renderTemplatePreview } from "./preview"
import { contentProblems, validContent } from "./validate"
import type { AppliedWording } from "./apply"

const LENDER = {
  legalName: "Synthetic Alpha Asset Finance (Pty) Ltd", tradingName: "Alpha Demo Finance", companyRegNumber: "2099/000001/07",
  ncrNumber: "NCRCP99901", registeredOfficeLines: ["1 Alpha Way", "Sampletown", "0001"],
}
const starter = (key: string) => starterContent(parseTemplateKey(key)!)
const withEdits = (key: string, edit: Partial<AssetTemplateContent>): AssetTemplateContent => ({ ...starter(key), ...edit })
const messages = (key: string, content: AssetTemplateContent) => contentProblems(key, content).map((p) => `${p.field}: ${p.message}`)
const words = async (pdf: Buffer) => prose(await texts(pdf)).replace(/\s+/g, " ")

describe("template families and content", () => {
  it("every family variant's starter content is valid", () => {
    expect(ALL_TEMPLATE_KEYS).toHaveLength(11)
    for (const key of ALL_TEMPLATE_KEYS) expect(messages(key, starter(key)), key).toEqual([])
  })

  it("canonical content is stable whatever the key order, and its hash is SHA-256 of that text", () => {
    const a = starter("af.isa.cpa")
    const b = { additionalTerms: a.additionalTerms, clauses: Object.fromEntries(Object.entries(a.clauses).reverse()), starterRevision: a.starterRevision, schema: 1 as const, templateKey: a.templateKey }
    expect(canonicalContent(b)).toBe(canonicalContent(a))
    expect(contentSha256(canonicalContent(a))).toMatch(/^[0-9a-f]{64}$/)
    expect(parseContent(canonicalContent(a))).toEqual(a)
    expect(parseContent(JSON.stringify({ ...a, extra: 1 }))).toBeNull()
  })

  it("numbers additional terms after the last protected clause", () => {
    expect(additionalTermNumber(parseTemplateKey("af.isa.cpa")!.family, "cpa", 0)).toBe("7.14")
    expect(additionalTermNumber(parseTemplateKey("af.nca.instalment_sale")!.family, "instalment_sale", 1)).toBe("13")
    expect(additionalTermNumber(parseTemplateKey("af.lease.fml.cpa")!.family, "cpa", 0)).toBe("9.18")
    expect(additionalTermNumber(parseTemplateKey("af.resolution.standard")!.family, "standard", 0)).toBe("4.4")
  })
})

describe("lender wording validation", () => {
  const key = "af.isa.commercial"
  it("refuses leaving out an editable clause, an extra clause, and a blank clause", () => {
    const { insurance: _omit, ...rest } = starter(key).clauses
    expect(messages(key, withEdits(key, { clauses: rest })).join()).toMatch(/editable clauses are exactly/)
    expect(messages(key, withEdits(key, { clauses: { ...starter(key).clauses, payment: "The purchaser pays whenever it likes to." } })).join()).toMatch(/editable clauses are exactly/)
    expect(messages(key, withEdits(key, { clauses: { ...starter(key).clauses, insurance: "   " } })).join()).toMatch(/required and cannot be left out/)
  })

  it.each([
    ["an amount", "The Purchaser pays an administration fee of R 500 on signature."],
    ["an amount without a space", "The Purchaser pays an administration fee of R500 on signature."],
    ["rands", "An administration fee of five hundred rand is payable on signature."],
    ["a percentage", "Default interest accrues at 2% a month on every overdue amount."],
    ["per cent", "Default interest accrues at two per cent a month on overdue amounts."],
  ])("refuses %s in lender text", (_, text) => {
    const result = messages(key, withEdits(key, { additionalTerms: [{ heading: "Fees", text }] }))
    expect(result.join()).toMatch(/come only from the deal's figures/)
  })

  it("refuses unknown tokens, stray braces, a missing required token and a clause that does not exist", () => {
    const term = (text: string) => messages(key, withEdits(key, { additionalTerms: [{ heading: "Extra", text }] })).join()
    expect(term("Signed for {{lender.bankAccount}} by its director only.")).toMatch(/not a token this document supports/)
    expect(term("Signed for {{lender.legalName} by its director only.")).toMatch(/stray brace/)
    expect(term("This term applies together with clause 7.40 of this Agreement.")).toMatch(/Clause 7.40 does not exist/)
    expect(term("This term applies together with clauses 7.6 and 7.12 of this Agreement.")).toBe("")
    const notices = starter(key).clauses.notices.replace("{{purchaser.domicilium}}", "its address")
    expect(messages(key, withEdits(key, { clauses: { ...starter(key).clauses, notices } })).join()).toMatch(/Must contain \{\{purchaser.domicilium\}\}/)
    // A token another family offers is not this one's.
    expect(messages("af.nca.instalment_sale", withEdits("af.nca.instalment_sale", { additionalTerms: [{ heading: "Extra", text: "Trading as {{lender.tradingName}} for all purposes." }] })).join()).toMatch(/not a token/)
  })

  it("refuses characters the PDF fonts would substitute, more than ten terms, and content of another document", () => {
    expect(messages(key, withEdits(key, { additionalTerms: [{ heading: "Extra", text: "Payable to 李明 on the due date as agreed." }] })).join()).toMatch(/cannot print/)
    const terms = Array.from({ length: 11 }, () => ({ heading: "Extra", text: "A lawful additional term of this agreement." }))
    expect(messages(key, withEdits(key, { additionalTerms: terms })).join()).toMatch(/At most 10/)
    expect(messages(key, starter("af.isa.cpa")).join()).toMatch(/different document/)
    expect(validContent(key, "{not json").ok).toBe(false)
  })
})

describe("which variants take lender text", () => {
  const term = { heading: "Extra", text: "A lawful additional term of this agreement." }
  it.each(["af.isa.cpa", "af.lease.operating.cpa", "af.lease.fml.cpa", "af.nca.instalment_sale", "af.nca.finance_lease", "af.suretyship.nca", "af.suretyship.commercial", "af.resolution.standard"])(
    "%s takes no clause edits and no additional terms: its version approves the protected starter",
    (key) => {
      expect(starter(key).clauses).toEqual({})
      expect(messages(key, withEdits(key, { additionalTerms: [term] })).join()).toMatch(/takes no additional terms/)
      expect(messages(key, withEdits(key, { clauses: { insurance: "The Purchaser insures the goods with any insurer it chooses." } })).join()).toMatch(/editable clauses are exactly: none/)
    },
  )
  it.each(["af.isa.commercial", "af.lease.operating.commercial", "af.lease.fml.commercial"])("%s takes its editable clauses and additional terms", (key) => {
    expect(messages(key, withEdits(key, { additionalTerms: [term] }))).toEqual([])
  })
  it.each([
    "Notwithstanding clause 7.4, the Seller may decide the payments.",
    "Despite anything else in this Agreement the Seller decides disputes.",
    "The Seller may amend any term of this Agreement by written notice.",
    "The Seller may vary the Schedule whenever it chooses to do so.",
    "Clause 7.8 does not apply to this Agreement in any circumstances.",
    "The Purchaser waives every right it has under this Agreement.",
    "An administration fee is payable on signature of this Agreement.",
    "The Seller may levy charges for every notice it sends to the Purchaser.",
    "A penalty is payable on every late payment under this Agreement.",
  ])("refuses override, variation, waiver and charge language: %s", (text) => {
    expect(messages("af.isa.commercial", withEdits("af.isa.commercial", { additionalTerms: [{ heading: "Extra", text }] })).join()).toMatch(/may not override, vary or waive/)
  })
  it("names every refused word, not only the first", () => {
    const text = "Notwithstanding clause 7.8 the Seller may waive notice and levy a fee on the Purchaser; a second Fee is due."
    expect(messages("af.isa.commercial", withEdits("af.isa.commercial", { additionalTerms: [{ heading: "Extra", text }] })).join())
      .toContain(`"Notwithstanding", "waive", "levy", "fee": lender text may not override`)
  })
  it("refuses an unknown starter revision", () => {
    expect(messages("af.isa.commercial", withEdits("af.isa.commercial", { starterRevision: "2099-01-01.9" })).join()).toMatch(/Unknown starter revision/)
  })
})

describe("rendering lender wording", () => {
  const data = syntheticDealDocumentData({ lender: LENDER, isaCpaApplies: true })
  const own: AssetTemplateContent = withEdits("af.isa.cpa", {
    clauses: { ...starter("af.isa.cpa").clauses, insurance: "ALPHA INSURANCE: the Purchaser insures the Goods with an insurer of its choice for their full value and notes {{lender.legalName}} as owner." },
    additionalTerms: [{ heading: "Alpha site visits", text: "{{lender.tradingName}} may visit the site where the Goods are kept, on reasonable notice." }],
  })

  it("starter content renders the same bytes as the starter itself (protected text untouched)", async () => {
    const wording: AppliedWording = { templateKey: "af.isa.cpa", content: starter("af.isa.cpa"), mark: "DRAFT" }
    expect((await renderInstalmentSaleAgreement(data, wording)).equals(await renderInstalmentSaleAgreement(data))).toBe(true)
  })

  it("replaces only the editable clause, keeps the CPA appendix, and numbers additional terms after 7.13", async () => {
    const text = await words(await renderInstalmentSaleAgreement(data, { templateKey: "af.isa.cpa", content: own, mark: "SYNTHETIC_DEMO" }))
    expect(text).toContain("ALPHA INSURANCE: the Purchaser insures the Goods with an insurer of its choice for their full value and notes Synthetic Alpha Asset Finance (Pty) Ltd as owner.")
    expect(text).not.toContain("comprehensively insured, for their full replacement value")
    expect(text).toContain("7.14 Alpha site visits")
    expect(text).toContain("Alpha Demo Finance may visit the site")
    // The CPA s49 notice on 7.2 and the cession saving on 7.11 still print; the payment and interest clauses are the starter's.
    expect(text).toContain("NOTICE UNDER SECTION 49")
    expect(text).toContain("No cession or delegation reduces a right or remedy the Purchaser has under the Consumer Protection Act.")
    expect(text).toContain("The Seller applies every amount it receives under this Agreement in this order")
  })

  it("the CPA appendix of 7.11 still prints after the lender replaces the clause it is appended to", async () => {
    const content = withEdits("af.isa.cpa", { clauses: { ...starter("af.isa.cpa").clauses, cession: "ALPHA CESSION: the Seller may cede this Agreement to its funder on written notice to the Purchaser." } })
    const text = await words(await renderInstalmentSaleAgreement(data, { templateKey: "af.isa.cpa", content, mark: "DRAFT" }))
    expect(text).toContain("ALPHA CESSION: the Seller may cede this Agreement to its funder on written notice to the Purchaser. No cession or delegation reduces a right or remedy the Purchaser has under the Consumer Protection Act.")
  })

  it("prints the synthetic demo watermark, never the draft one, for a demo approval; nothing for a legal approval", async () => {
    const demo = await texts(await renderInstalmentSaleAgreement(data, { templateKey: "af.isa.cpa", content: own, mark: "SYNTHETIC_DEMO" }))
    expect(demo).toContain(SYNTHETIC_DEMO_WATERMARK)
    expect(demo).not.toContain(DRAFT_WATERMARK)
    const legal = await texts(await renderInstalmentSaleAgreement({ ...data, legalWordingApproved: false }, { templateKey: "af.isa.cpa", content: own, mark: "NONE" }))
    expect(legal).not.toContain(SYNTHETIC_DEMO_WATERMARK)
    expect(legal).not.toContain(DRAFT_WATERMARK)
  })

  it("the legacy flag does not lift the mark of a template render", async () => {
    const pdf = await renderInstalmentSaleAgreement({ ...data, legalWordingApproved: true }, { templateKey: "af.isa.cpa", content: own, mark: "DRAFT" })
    expect(await texts(pdf)).toContain(DRAFT_WATERMARK)
  })

  it("previews every variant with the lender identity and the DRAFT mark (lender text where the variant takes it)", async () => {
    for (const key of ALL_TEMPLATE_KEYS) {
      const k = parseTemplateKey(key)!
      const content = takesLenderText(k) ? withEdits(key, { additionalTerms: [{ heading: "Preview marker term", text: "This preview term names {{lender.legalName}} only." }] }) : starter(key)
      expect(messages(key, content), key).toEqual([])
      const lines = await texts(await renderTemplatePreview(key, content, LENDER))
      const text = prose(lines).replace(/\s+/g, " ")
      expect(lines, key).toContain(DRAFT_WATERMARK)
      expect(text, key).toContain("Synthetic Alpha Asset Finance (Pty) Ltd")
      if (takesLenderText(k)) expect(text, key).toContain(`${additionalTermNumber(k.family, k.variant, 0)} Preview marker term`)
    }
  })

  it("a lease replaces 9.13 only (renderer mechanism, also under the CPA variant's initial lines)", async () => {
    const leaseKey = "af.lease.operating.cpa"
    const content = withEdits(leaseKey, { clauses: { cession: "ALPHA CESSION: the lessor may cede this lease to a funder; the lessee may not cede it without consent." } })
    const text = await words(await renderTemplatePreview(leaseKey, content, LENDER))
    expect(text).toContain("9.13 Cession and assignment ALPHA CESSION")
    expect(text).toContain("Lessee's initials:")
    expect(text).toContain("9.14 Domicilium and notices")
  })
})
