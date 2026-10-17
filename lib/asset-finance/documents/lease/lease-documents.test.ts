import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import { pdfPageContents } from "@/lib/pdf/__tests__/pdf-test-utils"
import { formatZarPdf } from "@/lib/pdf/helpers"
import { priceLease } from "../../lease-pricing"
import { leaseScheduleView } from "../../lease-view"
import { DRAFT_WATERMARK, PLACEHOLDER_CLAUSE } from "../pdf-layout"
import { renderDealDocument } from "../render"
import { syntheticDealDocumentData } from "../synthetic-deal.fixture"
import type { AnyDealDocumentData } from "../deal-document-data"
import { leaseAgreementClauses, type LeaseWordingInput } from "../wording/lease-agreement"
import { renderLeaseAgreement } from "./agreement-pdf"
import type { LeaseDocumentTerms } from "./lease-document-data"

const CP1252_HIGH = "€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008dŽ\u008f\u0090‘’“”•–—˜™š›œ\u009džŸ"
const winAnsi = (hex: string) =>
  [...Buffer.from(hex, "hex")].map((b) => (b >= 0x80 && b <= 0x9f ? CP1252_HIGH[b - 0x80] : String.fromCharCode(b))).join("")
async function pageTexts(bytes: Buffer): Promise<string[][]> {
  return (await pdfPageContents(bytes)).map((content) => [...content.matchAll(/<([0-9A-Fa-f]+)> Tj/g)].map((m) => winAnsi(m[1])))
}
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex")
// Wrapped lines rejoined: the words, in order, of everything on the document.
const words = (text: string) => text.split(/\s+/).filter(Boolean).join(" ")

// Synthetic FML: R1.5m ex VAT, R300k residual, 36 rentals in arrears at 11.75%, 8% escalation, R4 500 maintenance.
const priced = priceLease({
  cashPriceExclVatCents: 150_000_000, residualCents: 30_000_000, periods: 36, rentalTiming: "ARREARS", escalationRate: "0.08",
  startDate: "2026-12-31", firstDueDate: "2027-01-31", ratePath: [{ effectiveDate: "2026-12-31", annualRate: 0.1175 }],
  maintenance: { monthlyExclVatCents: 450_000, escalationRate: "0.065" }, vatRateTenThousandths: 1500,
})
const lease: LeaseDocumentTerms = {
  contractType: "FULL_MAINTENANCE_LEASE",
  terms: {
    rentalTiming: "ARREARS", escalationRate: "0.08", earlyTerminationPenaltyRate: "0.1",
    maintenance: { monthlyExclVatCents: 450_000, escalationRate: "0.065", riskModel: "LESSEE_SETTLED" },
    usage: { allowancePerYear: 1_500, unit: "HOURS", excessRateCents: 35_000 },
  },
  schedule: leaseScheduleView(priced, "0.1500"),
  endDate: "2029-12-31",
  cpaApplies: false,
  cpaRule: "CPA_JURISTIC_OVER_THRESHOLD",
}
const fml: AnyDealDocumentData = { ...syntheticDealDocumentData(), lease }
const soleProprietor: AnyDealDocumentData = {
  ...syntheticDealDocumentData(), entity: null,
  soleProprietor: { clientId: "client-lessee", name: "Test Soleprop", idNumber: "0000000000000", addressLines: ["3 Test Lane", "Pretoria"] },
  signatories: [{ clientId: "client-lessee", name: "Test Soleprop", idNumber: "0000000000000" }], sureties: [],
  lease: { ...lease, contractType: "OPERATING_LEASE", terms: { ...lease.terms, maintenance: null, usage: null }, cpaApplies: true, cpaRule: "CPA_NATURAL_PERSON" },
}

describe("lease agreements (C9)", () => {
  it("prints the real rentals, maintenance annexure and CPA statement under a DRAFT watermark on every page", async () => {
    const pages = await pageTexts(await renderLeaseAgreement(fml))
    const all = pages.flat()
    for (const page of pages) expect(page).toContain(DRAFT_WATERMARK)
    expect(all).toContain("FULL MAINTENANCE LEASE AGREEMENT")
    expect(all).toContain("7. ANNEXURE A — MAINTENANCE AND USAGE")
    expect(all).toContain(formatZarPdf(priced.periods[0].totalCents))
    expect(all).toContain(formatZarPdf(priced.totalCents))
    expect(all.some((line) => line.includes("1,500 hours a year") || line.includes("1 500 hours a year"))).toBe(true)
    expect(all.some((line) => line.includes("does not apply to this lease"))).toBe(true)
    expect(all.join(" ")).not.toMatch(/National Credit Act|NCA/)
  })

  // The wording module's own clauses, as the renderer is given them.
  const wordingOf = (data: AnyDealDocumentData): LeaseWordingInput => ({
    lessorName: data.lender.legalName, lesseeName: data.entity?.legalName ?? data.soleProprietor?.name ?? "", fml: data.lease?.contractType === "FULL_MAINTENANCE_LEASE",
    cpa: data.lease?.cpaApplies ?? false, terms: data.lease!.terms, pricing: data.pricing, startDate: data.pricing.startDate, endDate: data.lease!.endDate,
  })
  async function expectEveryClause(data: AnyDealDocumentData, count: number): Promise<string> {
    const lines = (await pageTexts(await renderLeaseAgreement(data))).flat()
    // The page footer and watermark interrupt a clause that crosses a page.
    const text = words(lines.filter((l) => !/^Page \d+ of \d+$|^Ref /.test(l) && l !== DRAFT_WATERMARK).join(" "))
    expect(lines).not.toContain(PLACEHOLDER_CLAUSE)
    expect(text).not.toContain("Placeholder")
    const clauses = leaseAgreementClauses(wordingOf(data))
    expect(clauses).toHaveLength(count)
    clauses.forEach((c, i) => {
      expect(lines, c.heading).toContain(`9.${i + 1} ${c.heading}`)
      expect(c.text.length, c.heading).toBeGreaterThan(150)
      for (const paragraph of c.text.split(/\n{2,}/)) expect(text, c.heading).toContain(words(paragraph))
    })
    expect(lines).not.toContain(`9.${count + 1}`)
    return text
  }

  it("prints all 17 clauses of the FML in full, commercial terms, with the deal's own figures", async () => {
    const text = await expectEveryClause(fml, 17)
    expect(text).toContain(`Test Asset Lender (Pty) Ltd ("the lessor") lets to TEST Earthmoving (Pty) Ltd ("the lessee")`)
    expect(text).toContain("starts on the commencement date, 31 December 2026, and ends on 31 December 2029")
    expect(text).toContain("an early-termination penalty of 10.00% of that present value")
    expect(text).toMatch(/The contracted usage is 1.500 hours a year/)
    expect(text).toContain(`at ${formatZarPdf(35_000)} per hour excl. VAT`)
    expect(text).toContain(`maintenance charge of ${formatZarPdf(450_000)} a month excl. VAT (escalating by 6.50%`)
    expect(text).toContain("a surplus is refunded to the lessee, and a deficit is billed to the lessee")
    expect(text).toContain("at the contract rate plus 2.00% a year")
    expect(text).toContain(`A collection fee of ${formatZarPdf(45_000)}`)
    expect(text).toContain("linked to the Prime rate")
    expect(text).toContain("The rental increases by 8.00% on each anniversary")
    for (const commercial of ["voetstoots", "section 45 of the Magistrates' Courts Act", "attorney and own client", "prima facie proof"]) expect(text).toContain(commercial)
    for (const consumer of ["section 14(2)(d)", "section 49 of the CPA"]) expect(text).not.toContain(consumer)
  })

  it("a CPA lessee's operating lease has the 15 common clauses in their consumer form, and no commercial-only terms", async () => {
    const text = await expectEveryClause(soleProprietor, 15)
    expect(text).toContain(`("the lessor") lets to Test Soleprop ("the lessee")`)
    expect(text).toContain("IMPORTANT (section 49 of the CPA)")
    expect(text).toContain("as section 14(2)(d) of the CPA provides")
    expect(text).toContain("Section 14(2)(b)(i)(bb) of the CPA allows the lessee to cancel this lease at any time on 20 business days' notice")
    expect(text).toContain("regulation 5(2) of the CPA Regulations")
    expect(text).toContain("Section 7 records that no usage limit is contracted")
    for (const commercial of ["voetstoots", "Magistrates' Court", "attorney and own client", "prima facie", "without deduction or set-off"]) expect(text).not.toContain(commercial)
  })

  it("the DRAFT watermark follows the lender's approval of the wording", async () => {
    const approved = await pageTexts(await renderLeaseAgreement({ ...fml, legalWordingApproved: true }))
    expect(approved.flat()).not.toContain(DRAFT_WATERMARK)
    expect(words(approved.flat().join(" "))).toContain(words(leaseAgreementClauses(wordingOf(fml))[0].text.split("\n\n")[0]))
  })

  it("is deterministic: the same data renders the same bytes, so the sha256 binds what was signed", async () => {
    expect(sha(await renderLeaseAgreement(fml))).toBe(sha(await renderLeaseAgreement(fml)))
    const changed = { ...fml, lease: { ...lease, terms: { ...lease.terms, earlyTerminationPenaltyRate: "0.11" } } }
    expect(sha(await renderLeaseAgreement(changed))).not.toBe(sha(await renderLeaseAgreement(fml)))
  })

  it("a sole proprietor's operating lease names the lessee, says the CPA applies, and has only the agreement", async () => {
    const all = (await pageTexts((await renderDealDocument(soleProprietor, "AGREEMENT", "client-lessee")).bytes)).flat()
    expect(all).toContain("OPERATING LEASE AGREEMENT")
    expect(all).toContain("Sole proprietor (natural person)")
    expect(all.some((line) => line.includes("Consumer Protection Act, 2008 applies to this lease"))).toBe(true)
    expect(all.some((line) => line.includes("Maintenance"))).toBe(false)
    await expect(renderDealDocument(soleProprietor, "RESOLUTION", "client-lessee")).rejects.toThrow(/only its agreement/)
  })

  it("the instalment sale agreement is unchanged for a deal that is not a lease", async () => {
    const plain = syntheticDealDocumentData()
    const viaRender = (await renderDealDocument(plain, "AGREEMENT", "client-director")).bytes
    expect((await pageTexts(viaRender)).flat()).toContain("INSTALMENT SALE AGREEMENT")
  })
})
