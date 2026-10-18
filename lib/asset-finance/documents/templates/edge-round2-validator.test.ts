/**
 * Round-2 adversarial edge tests for the narrowed lender-text surface
 * (OVERRIDING / MONEY / RATE / DOTTED_NUMBER / MAX_HEADING in validate.ts).
 * Pure unit tests: no database.
 *
 * DEFECT tests fail on feat/lender-owned-templates e6c3706b; GUARD tests pass.
 */
import { PDFDocument, StandardFonts } from "pdf-lib"
import { describe, expect, it } from "vitest"
import { texts } from "../nca/nca-wording.test-helpers"
import { starterContent, type AssetTemplateContent } from "./content"
import { ALL_TEMPLATE_KEYS, parseTemplateKey } from "./families"
import { renderTemplatePreview } from "./preview"
import { contentProblems } from "./validate"

const KEY = "af.isa.commercial"
const withTerm = (text: string, heading = "Probe heading"): AssetTemplateContent => ({
  ...starterContent(parseTemplateKey(KEY)!),
  additionalTerms: [{ heading, text }],
})
const refused = (text: string) => contentProblems(KEY, withTerm(`This additional term says ${text} and nothing more.`)).length > 0
const A4_WIDTH = 595.28

describe("DEFECT: the OVERRIDING deny-list misses its own word forms", () => {
  it.each(["the lender's waivers of clause 7.3", "the amounts charged under clause 7.4", "Notwith-standing clause 7.3"])("refuses %j", (text) => {
    expect(refused(text)).toBe(true)
  })
})

describe("DEFECT: lender text still overrides protected clauses or creates charges in plain synonyms", () => {
  it.each([
    "in lieu of clause 7.3 the purchaser pays monthly in advance",
    "regardless of clause 7.3 the seller may repossess at once",
    "clause 7.3 is excluded",
    "clause 7.3 shall not be applicable",
    "clause 7.3 is replaced by this term",
    "the purchaser pays an administration levy each month",
    "the purchaser pays a commission to the seller on settlement",
    "the purchaser pays interest on late amounts at the seller's rate",
    "the purchaser pays a surcharge on every late instalment",
    "the purchaser pays liquidated damages on early settlement",
  ])("refuses %j", (text) => {
    expect(refused(text)).toBe(true)
  })
})

describe("DEFECT: money and rates written without a symbol", () => {
  it.each(["500 dollars", "50 cents", "12 p.a."])("refuses %j", (text) => {
    expect(refused(text)).toBe(true)
  })
})

describe("DEFECT: a heading made of tokens is bounded before the tokens are filled", () => {
  it("a 48-character heading of identity tokens passes, then prints the full registered office off the page", async () => {
    const heading = "{{lender.registeredOffice}} {{lender.legalName}}"
    const content = withTerm("A perfectly ordinary additional term of the lender.", heading)
    expect(contentProblems(KEY, content)).toEqual([])
    // A valid identity (identity-schema.ts: up to 6 office lines of 80 characters).
    const lender = {
      legalName: "TEST Asset and Equipment Finance Holdings (Pty) Ltd", tradingName: "TEST Finance",
      companyRegNumber: "2000/000001/07", ncrNumber: "NCRCP00001",
      registeredOfficeLines: ["Unit 1204, Twelfth Floor, North Tower", "135 Commissioner Street", "Marshalltown, Johannesburg", "2001"],
    }
    const pdf = await renderTemplatePreview(KEY, content, lender)
    const bold = await (await PDFDocument.create()).embedFont(StandardFonts.HelveticaBold)
    const run = (await texts(pdf)).find((t) => t.startsWith("7.14 "))
    expect(run).toBeDefined()
    expect(40 + bold.widthOfTextAtSize(run!, 9)).toBeLessThanOrEqual(A4_WIDTH - 40)
  }, 60_000)
})

describe("GUARD: round-2 rules that hold", () => {
  it("every starter (all 11 variants) passes its own validator", () => {
    for (const key of ALL_TEMPLATE_KEYS) expect(contentProblems(key, starterContent(parseTemplateKey(key)!)), key).toEqual([])
  })
  it.each(["notwithstanding clause 7.3", "clause 7.3 does not apply", "a fee", "penalties", "waived", "R5", "ZAR", "$5", "5‰", "50 bps", "7.99", "clause 7", "v1.2"])(
    "refuses %j", (text) => {
      expect(refused(text)).toBe(true)
    })
  it("CPA, NCA, suretyship and resolution variants take no lender text at all", () => {
    for (const key of ["af.isa.cpa", "af.lease.operating.cpa", "af.lease.fml.cpa", "af.nca.instalment_sale", "af.nca.finance_lease", "af.suretyship.nca", "af.suretyship.commercial", "af.resolution.standard"]) {
      const content = { ...starterContent(parseTemplateKey(key)!), additionalTerms: [{ heading: "Site visits", text: "The lender may inspect the goods on reasonable notice." }] }
      expect(contentProblems(key, content).length, key).toBeGreaterThan(0)
    }
  })
  it("{{purchaser.domicilium}} is refused outside the notices clause", () => {
    expect(refused("the purchaser's address {{purchaser.domicilium}}")).toBe(true)
  })
  it("an unknown starter revision is refused", () => {
    expect(contentProblems(KEY, { ...starterContent(parseTemplateKey(KEY)!), starterRevision: "1999-01-01.1" }).length).toBeGreaterThan(0)
  })
})
