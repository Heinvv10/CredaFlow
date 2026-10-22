// The introducer's commission disclosure and the lender-owned templates (part W):
// lender text cannot carry a commission, and the disclosure is fingerprinted
// through exactly one extra preview shape per variant that prints it.
import { describe, expect, it } from "vitest"
import { introducerRow, printed, withoutDisclosure, ISA_CLAUSE, LEASE_CLAUSE, NCA_CLAUSE, SECTION } from "./commission-disclosure.test-helpers"
import { texts } from "./nca/nca-wording.test-helpers"
import { starterContent } from "./templates/content"
import { ALL_TEMPLATE_KEYS, parseTemplateKey } from "./templates/families"
import { previewShapes, renderTemplatePreview } from "./templates/preview"
import { contentProblems } from "./templates/validate"

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

  it.each([
    ["a soft hyphen", "The dealer earns a commis­sion on every deal the lender finances."],
    ["a zero-width space", "The dealer earns a commis​sion on every deal the lender finances."],
    ["a zero-width non-joiner", "The dealer earns a commis‌sion on every deal the lender finances."],
    ["a zero-width joiner", "The dealer earns a commis‍sion on every deal the lender finances."],
    ["a word joiner", "The dealer earns a commis⁠sion on every deal the lender finances."],
    ["a byte-order mark", "The dealer earns a commis﻿sion on every deal the lender finances."],
  ])("refuses text hiding the word with %s", (_, text) => {
    const key = "af.isa.commercial"
    const content = { ...starterContent(parseTemplateKey(key)!), additionalTerms: [{ heading: "Dealer arrangements", text }] }
    expect(contentProblems(key, content).map((p) => p.message).join(" ")).toMatch(/invisible|soft hyphen|zero-width/i)
  })

  it("refuses the word in an editable clause too, and the starter wording still validates", () => {
    const key = "af.isa.commercial"
    const starter = starterContent(parseTemplateKey(key)!)
    expect(contentProblems(key, starter)).toEqual([])
    const content = { ...starter, clauses: { ...starter.clauses, insurance: `${starter.clauses.insurance} The Seller pays a commission on the premium.` } }
    expect(contentProblems(key, content).map((p) => p.field)).toEqual(["clauses.insurance"])
  })
})

describe("template previews carry the disclosure in exactly two extra shapes: a dealer and a broker", () => {
  const lender = { legalName: "Shape Lender (Pty) Ltd", tradingName: "Shape", companyRegNumber: "2000/000000/07", ncrNumber: "NCRCP00000", registeredOfficeLines: ["1 Street", "Town"] }
  const SAMPLE = { name: "SAMPLE Dealer (synthetic)", kind: "DEALER" as const }
  const BROKER = { ...SAMPLE, kind: "BROKER" as const }
  const CLAUSE: Record<string, { clause: string; heading: string | null } | undefined> = {
    "af.isa.commercial": { clause: ISA_CLAUSE, heading: null }, "af.isa.cpa": { clause: ISA_CLAUSE, heading: null },
    "af.lease.operating.commercial": { clause: LEASE_CLAUSE, heading: null }, "af.lease.operating.cpa": { clause: LEASE_CLAUSE, heading: null },
    "af.lease.fml.commercial": { clause: LEASE_CLAUSE, heading: null }, "af.lease.fml.cpa": { clause: LEASE_CLAUSE, heading: null },
    "af.nca.instalment_sale": { clause: NCA_CLAUSE("this agreement"), heading: SECTION }, "af.nca.finance_lease": { clause: NCA_CLAUSE("this agreement"), heading: SECTION },
  }
  const lines = async (key: string, shape: string | undefined) => texts(await renderTemplatePreview(key, starterContent(parseTemplateKey(key)!), lender, shape))

  it.each(ALL_TEMPLATE_KEYS)("%s: only the dealer and broker shapes print it, and each adds nothing else to the first shape", async (key) => {
    const expected = CLAUSE[key]
    const ids = previewShapes(key).map((s) => s.id)
    if (!expected) {
      expect(ids).not.toContain("dealer")
      expect(ids).not.toContain("broker")
      return
    }
    expect(ids.filter((id) => id === "dealer")).toHaveLength(1)
    expect(ids.filter((id) => id === "broker")).toHaveLength(1)
    for (const id of ids) {
      const text = printed(await lines(key, id))
      expect(text.includes(introducerRow(SAMPLE)), `${key} ${id}`).toBe(id === "dealer")
      expect(text.includes(introducerRow(BROKER)), `${key} ${id}`).toBe(id === "broker")
    }
    const first = printed(await lines(key, undefined))
    expect(withoutDisclosure(await lines(key, "dealer"), SAMPLE, expected.clause, expected.heading)).toEqual(first)
    expect(withoutDisclosure(await lines(key, "broker"), BROKER, expected.clause, expected.heading)).toEqual(first)
  }, 30_000)
})
