import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import { extractTokens, TOKEN_REGISTRY } from "../../lib/documents/tokens"
import { nonNcaTemplateSet } from "./non-nca-templates"

const KINDS = ["OFFER_LETTER", "KEY_FACTS_STATEMENT", "LOAN_AGREEMENT", "ARREARS_LETTER"]
const KNOWN = new Set(TOKEN_REGISTRY.map((t) => t.token))
const CBK_GAP = "[SAMPLE &mdash; the lender&rsquo;s Central Bank of Kenya licence number goes here. This demo lender holds no licence.]"

describe("the key-facts demo templates, by jurisdiction", () => {
  it("leaves the Lesotho bodies byte for byte as they were", () => {
    const ls = nonNcaTemplateSet("LS")
    expect(createHash("sha256").update(JSON.stringify(ls.bodies)).digest("hex")).toBe("2f771227fc107288aadf1a70581a2911ba06b1fb8c7722ea2e766d14919d614d")
    expect(ls.notes).toBe("Synthetic demo version: structure and approved figures only. The bank's legal team supplies the wording.")
  })

  it("gives Kenya its own bodies for the same four documents, marked DRAFT in the version notes", () => {
    const ke = nonNcaTemplateSet("KE")
    expect(Object.keys(ke.bodies).sort()).toEqual([...KINDS].sort())
    expect(ke.bodies).not.toEqual(nonNcaTemplateSet("LS").bodies)
    expect(ke.notes).toMatch(/^DRAFT — not reviewed by Kenyan counsel\./)
  })

  it("keeps the SAMPLE gap where the lender's legal wording goes, in every Kenyan document", () => {
    for (const body of Object.values(nonNcaTemplateSet("KE").bodies)) expect(body).toContain("[SAMPLE &mdash;")
  })

  it("asserts no licence the demo lender lacks: the CBK licence is a SAMPLE gap in every Kenyan document", () => {
    for (const body of Object.values(nonNcaTemplateSet("KE").bodies)) {
      expect(body).not.toMatch(/Regulated by|licensed by/i)
      expect(body).toContain(CBK_GAP)
    }
  })

  it("prints the repayment method as M-Pesa Paybill, not the approval's EFT, with the steps below it", () => {
    const ke = nonNcaTemplateSet("KE").bodies
    for (const body of Object.values(ke)) expect(body).not.toContain("{{quote.repaymentMethod}}")
    for (const kind of ["OFFER_LETTER", "KEY_FACTS_STATEMENT", "LOAN_AGREEMENT"] as const) {
      const row = ke[kind].indexOf("<tr><td>Repayment method</td><td>M-Pesa Paybill (see steps below)</td></tr>")
      expect(row, kind).toBeGreaterThan(-1)
      expect(ke[kind].indexOf("<h2>Repaying by M-Pesa Paybill</h2>"), kind).toBeGreaterThan(row)
    }
  })

  it("gives the M-Pesa Paybill route in the Kenyan key facts statement", () => {
    const kfs = nonNcaTemplateSet("KE").bodies.KEY_FACTS_STATEMENT
    expect(kfs).toMatch(/M-Pesa/)
    expect(kfs).toMatch(/Paybill/)
  })

  it("discloses in the key facts statement the CBK product approval reference, the excise inside the fees and the total cost of credit", () => {
    const ke = nonNcaTemplateSet("KE").bodies
    const kfs = ke.KEY_FACTS_STATEMENT
    expect(kfs).toContain("<tr><td>CBK product approval reference</td><td>{{product.regulatorApprovalRef}}</td></tr>")
    // Whether the excise is inside the fees or on top is the lender's finance team's to confirm: a SAMPLE gap, not a statement.
    expect(kfs).toContain("<tr><td>Excise duty included in the fees above [SAMPLE &mdash; the lender&rsquo;s finance team confirms whether excise is included or charged on top]</td><td>{{quote.exciseDuty}}</td></tr>")
    expect(kfs).not.toMatch(/not charged on top/)
    expect(kfs).toContain("<tr><td>Total cost of credit (interest and fees)</td><td>{{quote.totalCostOfCredit}}</td></tr>")
    // The other three are unchanged: the arrears letter has no application product to read a reference from.
    for (const kind of ["OFFER_LETTER", "LOAN_AGREEMENT", "ARREARS_LETTER"] as const) expect(ke[kind], kind).not.toContain("{{product.regulatorApprovalRef}}")
  })

  it.each(["LS", "KE"] as const)("%s uses only tokens the renderer knows (an unknown one blocks the document)", (j) => {
    for (const body of Object.values(nonNcaTemplateSet(j).bodies)) {
      expect(extractTokens(body).filter((t) => !KNOWN.has(t))).toEqual([])
    }
  })

  it("has none for a South African lender, whose documents are the NCA ones", () => {
    expect(() => nonNcaTemplateSet("ZA")).toThrow(/ZA/)
  })
})
