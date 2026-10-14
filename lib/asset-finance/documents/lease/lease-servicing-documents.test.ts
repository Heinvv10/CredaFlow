import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import { pdfPageContents } from "@/lib/pdf/__tests__/pdf-test-utils"
import { formatZarPdf } from "@/lib/pdf/helpers"
import { DRAFT_WATERMARK, PLACEHOLDER_CLAUSE } from "../pdf-layout"
import { renderLeaseExpiryNotice } from "./expiry-notice-pdf"
import { renderLeaseInspectionReport } from "./inspection-report-pdf"
import { renderLeaseTerminationQuote } from "./termination-quote-pdf"
import { BASIS, LENDER, NOTICE, QUOTE, REPORT } from "./lease-docs.fixture"

// The lease servicing documents (C9): the CPA expiry notice, the early-
// termination quote and the inspection report print the row's real figures,
// carry the DRAFT watermark on every page and render byte-identically.
const CP1252_HIGH = "€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008dŽ\u008f\u0090‘’“”•–—˜™š›œ\u009džŸ"
const winAnsi = (hex: string) =>
  [...Buffer.from(hex, "hex")].map((b) => (b >= 0x80 && b <= 0x9f ? CP1252_HIGH[b - 0x80] : String.fromCharCode(b))).join("")
async function pageTexts(bytes: Buffer): Promise<string[][]> {
  return (await pdfPageContents(bytes)).map((content) => [...content.matchAll(/<([0-9A-Fa-f]+)> Tj/g)].map((m) => winAnsi(m[1])))
}
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex")

describe("CPA expiry notice", () => {
  it("names the lessee, lease, goods, expiry date, options and the lender's contacts, under a DRAFT watermark", async () => {
    const pages = await pageTexts(await renderLeaseExpiryNotice(NOTICE, LENDER))
    const all = pages.flat()
    for (const page of pages) expect(page).toContain(DRAFT_WATERMARK)
    expect(all).toContain("NOTICE OF EXPIRY OF YOUR LEASE")
    for (const value of [NOTICE.lessee, NOTICE.reference, NOTICE.asset, "30 June 2027", LENDER.legalName, LENDER.publicEmail, LENDER.collectionsPhone]) {
      expect(all.some((line) => line.includes(value)), value).toBe(true)
    }
    for (const option of ["Return the goods", "Extend month to month", "Buy the goods"]) expect(all).toContain(option)
    expect(all.join(" ")).toContain("fair market value")
    expect(all).toContain(PLACEHOLDER_CLAUSE)
  })

  it("carries no watermark once the lender's wording is approved, and is deterministic", async () => {
    expect(sha(await renderLeaseExpiryNotice(NOTICE, LENDER))).toBe(sha(await renderLeaseExpiryNotice(NOTICE, LENDER)))
    const approved = (await pageTexts(await renderLeaseExpiryNotice({ ...NOTICE, draft: false }, LENDER))).flat()
    expect(approved).not.toContain(DRAFT_WATERMARK)
    expect(sha(await renderLeaseExpiryNotice({ ...NOTICE, expiryDate: "2027-07-31" }, LENDER))).not.toBe(sha(await renderLeaseExpiryNotice(NOTICE, LENDER)))
  })
})

describe("early-termination quote", () => {
  it("prints every figure of the quote row and its basis verbatim, under a DRAFT watermark", async () => {
    const pages = await pageTexts(await renderLeaseTerminationQuote(QUOTE, LENDER))
    const all = pages.flat()
    for (const page of pages) expect(page).toContain(DRAFT_WATERMARK)
    expect(all).toContain("EARLY-TERMINATION QUOTE")
    for (const cents of [QUOTE.pvCents, QUOTE.penaltyCents, QUOTE.invoiceVatCents, QUOTE.arrearsCents, QUOTE.totalCents]) expect(all).toContain(formatZarPdf(cents))
    for (const date of ["23 February 2027", "15 March 2027", "5 March 2027"]) expect(all.some((line) => line.includes(date)), date).toBe(true)
    expect(all).toContain("14")
    // The basis wraps over lines; its words, in order, are the stored text.
    const words = (text: string) => text.split(/\s+/).filter(Boolean).join(" ")
    expect(words(all.join(" "))).toContain(words(BASIS))
    expect(all.join(" ")).toContain("CPA Regulation 5(2)")
  })

  it("is deterministic and changes with any figure", async () => {
    expect(sha(await renderLeaseTerminationQuote(QUOTE, LENDER))).toBe(sha(await renderLeaseTerminationQuote(QUOTE, LENDER)))
    expect(sha(await renderLeaseTerminationQuote({ ...QUOTE, totalCents: QUOTE.totalCents + 1 }, LENDER))).not.toBe(sha(await renderLeaseTerminationQuote(QUOTE, LENDER)))
  })
})

describe("inspection report", () => {
  it("prints the condition, both readings, each damage line and the totals, under a DRAFT watermark", async () => {
    const pages = await pageTexts(await renderLeaseInspectionReport(REPORT, LENDER))
    const all = pages.flat()
    for (const page of pages) expect(page).toContain(DRAFT_WATERMARK)
    expect(all).toContain("END-OF-TERM INSPECTION REPORT")
    expect(all.some((line) => line.includes("cracked side mirror"))).toBe(true)
    expect(all.some((line) => line.includes("120 hours on 1 July 2024"))).toBe(true)
    expect(all.some((line) => /4.620 hours on 2 July 2027/.test(line))).toBe(true)
    expect(all.some((line) => /4.500 hours/.test(line))).toBe(true)
    for (const cents of [123_456, 765_432, 123_456 + 765_432, 1_750_000, 123_456 + 765_432 + 1_750_000]) expect(all).toContain(formatZarPdf(cents))
  })

  it("says so when there is no damage and the excess usage is not yet invoiced", async () => {
    const all = (await pageTexts(await renderLeaseInspectionReport({ ...REPORT, damage: [], excessUsageCents: null, finalReading: null }, LENDER))).flat()
    expect(all).toContain("No damage recorded")
    expect(all).toContain("Not yet invoiced")
    expect(all).toContain(formatZarPdf(0))
  })

  it("is deterministic and changes with a damage amount", async () => {
    expect(sha(await renderLeaseInspectionReport(REPORT, LENDER))).toBe(sha(await renderLeaseInspectionReport(REPORT, LENDER)))
    const changed = { ...REPORT, damage: [{ description: "Replace cracked side mirror", amountExclVatCents: 123_457 }] }
    expect(sha(await renderLeaseInspectionReport(changed, LENDER))).not.toBe(sha(await renderLeaseInspectionReport(REPORT, LENDER)))
  })
})
