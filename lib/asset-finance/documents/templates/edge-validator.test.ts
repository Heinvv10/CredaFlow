/**
 * Adversarial edge tests for the lender-text validator and the renderers it
 * feeds (docs/asset-finance/evidence/lender-owned-templates/SPEC.md §2
 * "Lender text validation"). Pure unit tests: no database.
 *
 * DEFECT tests failed on feat/lender-owned-templates db87ae79 and pass since
 * the review-round-1 fixes; GUARD tests pin attacks that did not break the code.
 */
import { PDFDocument, StandardFonts } from "pdf-lib"
import { describe, expect, it } from "vitest"
import { texts } from "../nca/nca-wording.test-helpers"
import { starterContent, type AssetTemplateContent } from "./content"
import { parseTemplateKey } from "./families"
import { renderTemplatePreview } from "./preview"
import { contentProblems } from "./validate"

const KEY = "af.isa.commercial"
const withTerm = (text: string, heading = "Probe heading", key = KEY): AssetTemplateContent => ({
  ...starterContent(parseTemplateKey(key)!),
  additionalTerms: [{ heading, text }],
})
const refused = (text: string) => contentProblems(KEY, withTerm(`This additional term says ${text} and nothing more.`)).length > 0
const lender = {
  legalName: "TEST Lender (Pty) Ltd", tradingName: "TEST Lender", companyRegNumber: "2000/000001/07",
  ncrNumber: "NCRCP00001", registeredOfficeLines: ["1 Test Street", "Testville"],
}
const A4_WIDTH = 595.28

describe("DEFECT: money the validator lets through (SPEC: no money, `R 1`, `R1`, `ZAR`, `rand`)", () => {
  it.each(["ZAR1000", "ZAR500.00"])("refuses %s (ZAR glued to the digits: \\bZAR\\b never matches)", (money) => {
    expect(refused(money)).toBe(true)
  })
  it.each(["R  100 000", "R   5"])("refuses %j (two or more spaces after R: \\s? allows only one)", (money) => {
    expect(refused(money)).toBe(true)
  })
  it.each(["$500", "USD 500", "€500", "EUR 500", "£500"])("refuses %s (other currencies are money too)", (money) => {
    expect(refused(money)).toBe(true)
  })
})

describe("DEFECT: rates the validator lets through (SPEC: no percentages/rates)", () => {
  it.each(["5‰ per month", "50 basis-points"])("refuses %s", (rate) => {
    expect(refused(rate)).toBe(true)
  })
})

describe("DEFECT: references to clauses that do not exist (SPEC: `clause N.M` must exist)", () => {
  it.each([
    "see clause 7.12.3",
    "see clauses 7.6 & 7.99",
    "see clauses 7.6; 7.99",
    "see clauses 7.6 and/or 7.99",
  ])("refuses %j", (ref) => {
    expect(refused(ref)).toBe(true)
  })
})

describe("DEFECT: approved lender text the renderer cannot show", () => {
  it("FIXED: a 3,990-character unbroken word is refused, and the longest word allowed prints whole", async () => {
    expect(contentProblems(KEY, withTerm("A".repeat(3990), "Long reference")).map((p) => p.message).join()).toMatch(/word may be at most 30 characters/)
    const content = withTerm(`${"W".repeat(30)} is the longest word a lender may write.`, "Long reference")
    expect(contentProblems(KEY, content)).toEqual([])
    const pdf = await renderTemplatePreview(KEY, content, lender)
    const font = await (await PDFDocument.create()).embedFont(StandardFonts.Helvetica)
    expect((await texts(pdf)).some((run) => run.includes("W".repeat(30)))).toBe(true)
    const widest = Math.max(...(await texts(pdf)).map((run) => font.widthOfTextAtSize(run, 9)))
    expect(widest).toBeLessThanOrEqual(A4_WIDTH)
  }, 60_000)

  it("FIXED: an 80-character heading is refused, and the longest heading allowed prints within the page", async () => {
    expect(contentProblems(KEY, withTerm("A perfectly ordinary additional term of the lender.", "W".repeat(80))).map((p) => p.message).join()).toMatch(/At most 50 characters/)
    const heading = "W".repeat(50)
    const content = withTerm("A perfectly ordinary additional term of the lender.", heading)
    expect(contentProblems(KEY, content)).toEqual([])
    const pdf = await renderTemplatePreview(KEY, content, lender)
    const bold = await (await PDFDocument.create()).embedFont(StandardFonts.HelveticaBold)
    const run = (await texts(pdf)).find((t) => t.includes(heading))!
    expect(run).toBeDefined()
    expect(40 + bold.widthOfTextAtSize(run, 9)).toBeLessThanOrEqual(A4_WIDTH - 40)
  }, 60_000)
})

describe("GUARD: attacks that the validator refuses (pass today)", () => {
  it.each([
    "R 1 000", "R1,000", "r500", "R 500", "1000ZAR", "one hundred rand", "R\n500",
    "5 %", "５％", "five per cent", "10 percent", "25 basis points", "R١٠٠",
  ])("refuses money/rate %j", (text) => {
    expect(refused(text)).toBe(true)
  })
  it.each(["see clause 7.40", "see clauses 7.1to7.99", "see clause 99", "see Clause\n7.99", "see clause 7.99A", "see clauses 7.6, 7.11 or 7.99"])(
    "refuses nonexistent clause reference %j", (ref) => {
      expect(refused(ref)).toBe(true)
    })
  it.each(["{{constructor}}", "{{__proto__}}", "{{lender.ncrNumber}}", "{{ lender.legalName }", "{lender.legalName}", "{{lender legalName}}"])(
    "refuses token %s", (token) => {
      expect(refused(token)).toBe(true)
    })
  it("refuses a heading with a line break, a tab, a carriage return or a Unicode line separator", () => {
    for (const heading of ["Two\nlines", "Tab\there", "CR\rhere", "LS here"]) {
      expect(contentProblems(KEY, withTerm("A perfectly ordinary additional term of the lender.", heading)).length, JSON.stringify(heading)).toBeGreaterThan(0)
    }
  })
  it("refuses lender.tradingName in an NCA agreement (the NCA renderer has no value for it)", () => {
    const content = withTerm("The credit provider {{lender.tradingName}} may inspect the goods.", "Inspection", "af.nca.instalment_sale")
    expect(contentProblems("af.nca.instalment_sale", content).length).toBeGreaterThan(0)
  })
  it("refuses removing an editable clause or adding an unknown one", () => {
    const base = starterContent(parseTemplateKey(KEY)!)
    const { insurance: _drop, ...rest } = base.clauses
    expect(contentProblems(KEY, { ...base, clauses: rest }).length).toBeGreaterThan(0)
    expect(contentProblems(KEY, { ...base, clauses: { ...base.clauses, pricing: "Pricing is whatever the lender says it is today." } }).length).toBeGreaterThan(0)
  })
  it("refuses an eleventh additional term", () => {
    const base = starterContent(parseTemplateKey(KEY)!)
    const terms = Array.from({ length: 11 }, (_, i) => ({ heading: `Term ${i}`, text: "A perfectly ordinary additional term of the lender." }))
    expect(contentProblems(KEY, { ...base, additionalTerms: terms }).length).toBeGreaterThan(0)
  })
})
