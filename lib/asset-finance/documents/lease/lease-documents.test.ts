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
import { renderLeaseAgreement } from "./agreement-pdf"
import type { LeaseDocumentTerms } from "./lease-document-data"

const CP1252_HIGH = "€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008dŽ\u008f\u0090‘’“”•–—˜™š›œ\u009džŸ"
const winAnsi = (hex: string) =>
  [...Buffer.from(hex, "hex")].map((b) => (b >= 0x80 && b <= 0x9f ? CP1252_HIGH[b - 0x80] : String.fromCharCode(b))).join("")
async function pageTexts(bytes: Buffer): Promise<string[][]> {
  return (await pdfPageContents(bytes)).map((content) => [...content.matchAll(/<([0-9A-Fa-f]+)> Tj/g)].map((m) => winAnsi(m[1])))
}
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex")

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
    expect(all).toContain(PLACEHOLDER_CLAUSE)
    expect(all.join(" ")).not.toMatch(/National Credit Act|NCA/)
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
