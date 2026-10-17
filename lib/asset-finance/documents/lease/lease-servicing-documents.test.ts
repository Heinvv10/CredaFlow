import { createHash } from "node:crypto"
import { PDFDocument } from "pdf-lib"
import { afterEach, describe, expect, it, vi } from "vitest"
import { pdfPageContents } from "@/lib/pdf/__tests__/pdf-test-utils"
import { formatZarPdf } from "@/lib/pdf/helpers"
import { DRAFT_WATERMARK, PLACEHOLDER_CLAUSE } from "../pdf-layout"
import { expiryNoticeClauses, inspectionReportClauses, terminationQuoteClauses } from "../wording/lease-servicing"
import type { WordingClause } from "../wording/lease-agreement"
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
const words = (text: string) => text.split(/\s+/).filter(Boolean).join(" ")

/** Every clause renders as "<section>.<n> heading" followed by its full wording, and no placeholder renders. */
async function expectClauses(bytes: Buffer, section: number, clauses: WordingClause[]): Promise<string> {
  const lines = (await pageTexts(bytes)).flat()
  const text = words(lines.filter((l) => !/^Page \d+ of \d+$|^Ref /.test(l) && l !== DRAFT_WATERMARK).join(" "))
  expect(lines).not.toContain(PLACEHOLDER_CLAUSE)
  expect(text).not.toContain("Placeholder")
  clauses.forEach((c, i) => {
    expect(lines, c.heading).toContain(`${section}.${i + 1} ${c.heading}`)
    expect(c.text.length, c.heading).toBeGreaterThan(80)
    for (const paragraph of c.text.split(/\n{2,}/)) expect(text, c.heading).toContain(words(paragraph))
  })
  return text
}

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
  })

  it("says what happens if the lessee does nothing: CPA s14(2)(d) month-to-month continuation, with the notice period", async () => {
    const clauses = expiryNoticeClauses(NOTICE)
    expect(clauses.map((c) => c.heading)).toEqual(["Consequences of taking no action before the expiry date", "How to tell us your choice"])
    const text = await expectClauses(await renderLeaseExpiryNotice(NOTICE, LENDER), 4, clauses)
    expect(text).toContain("If you have not told us your choice by 30 June 2027, your lease does not simply end. As this agreement provides, it then continues "
      + "month to month after the expiry date. Section 14(2)(d) of the CPA does not apply to a juristic lessee, but this agreement gives you the same terms as it "
      + "gives a natural-person consumer. It continues on the same terms")
    expect(text).toContain("You may end the month-to-month lease at any time by giving us at least 20 business days' written notice")
    expect(text).toContain("We may end it by giving you one month's written notice")
    expect(text).toContain("Extend month to month Continue the lease month to month on the same rentals. You may end the extension on 20 business days' written notice")
    expect(text).toContain("through our client portal, or by written notice to us, which may be sent by email")
    expect(words(clauses.map((c) => c.text).join(" "))).not.toMatch(/telephone|Either of us/)
    expect(words(expiryNoticeClauses({ ...NOTICE, extensionNoticeMonths: 2 })[0].text)).toContain("giving you 2 months' written notice")
    expect(words(expiryNoticeClauses({ ...NOTICE, naturalPerson: true })[0].text)).toContain("your lease does not simply end. As section 14(2)(d) of the CPA provides, it then continues month to month after the expiry date. It continues")
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

  it("a CPA lessee's quote explains the s14 cancellation and the Reg 5(2) limit, with the quote's own dates", async () => {
    const clauses = terminationQuoteClauses(QUOTE)
    expect(clauses.map((c) => c.heading)).toEqual(["Your cancellation", "The cancellation charge", "If you disagree with the charge"])
    const text = await expectClauses(await renderLeaseTerminationQuote(QUOTE, LENDER), 5, clauses)
    expect(text).toContain("You gave us notice on 23 February 2027 to cancel your lease, as this agreement allows on 20 business days' notice. Section "
      + "14(2)(b)(i)(bb) of the CPA does not apply to a juristic lessee, but this agreement gives you the same terms as it gives a natural-person consumer. Your lease")
    expect(text).toContain("the lessor may charge only a reasonable cancellation penalty, as this agreement provides. This quote states that charge.")
    expect(text).not.toMatch(/on the terms section 14/)
    expect(text).toContain("Your lease therefore ends on 15 March 2027, whether or not you accept or pay this quote. The 14 rentals that would fall due after that date are cancelled.")
    expect(text).toContain("This quote states that charge.")
    expect(text).toContain("less (b) the net amount the lessor realises, or can reasonably expect to realise, by selling or letting the returned goods")
    expect(text).toContain("regulation 5(2) of the CPA Regulations")
    expect(text).toContain("National Consumer Commission or a court. A dispute does not delay your cancellation.")
    expect(text).toContain("6. HOW TO REACH US")
    expect(text).not.toMatch(/takes effect if you accept|6\. HOW TO ACCEPT/)
    expect(words(terminationQuoteClauses({ ...QUOTE, naturalPerson: true })[0].text)).toContain("to cancel your lease, as section 14(2)(b)(i)(bb) of the CPA allows on 20 business days' notice. Your lease")
  })

  it("a commercial lessee's quote is an offer to end the lease by agreement, with no CPA wording", async () => {
    const commercial = { ...QUOTE, cpaCancellation: false, basis: "Present value of the rentals plus a penalty plus the arrears." }
    const clauses = terminationQuoteClauses(commercial)
    expect(clauses.map((c) => c.heading)).toEqual(["What accepting this quote means", "Basis of early termination"])
    const text = await expectClauses(await renderLeaseTerminationQuote(commercial, LENDER), 5, clauses)
    expect(text).toContain("Your lease agreement does not give you a right to end the lease early.")
    expect(text).toContain("If you accept this quote within its validity, your lease ends on the day you accept it.")
    expect(text).toContain("with the termination date on the day you accept it")
    expect(text).toContain("6. HOW TO ACCEPT")
    expect(text).not.toMatch(/Consumer Protection Act|section 14|regulation 5|the day the quote was given/)
  })

  it("the quote's watermark follows the lender's approval of the wording", async () => {
    expect((await pageTexts(await renderLeaseTerminationQuote({ ...QUOTE, draft: false }, LENDER))).flat()).not.toContain(DRAFT_WATERMARK)
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

  it("explains fair wear and tear, the damage, the excess usage, payment and how to object, then the lessor's contacts", async () => {
    const clauses = inspectionReportClauses(REPORT)
    expect(clauses).toHaveLength(5)
    const text = await expectClauses(await renderLeaseInspectionReport(REPORT, LENDER), 6, clauses)
    expect(text).toContain("Damage is charged only where it goes beyond fair wear and tear.")
    expect(text).toContain(`The excess-usage charge in section 5 (${formatZarPdf(1_750_000)} excl. VAT)`)
    expect(text).toContain("payable within 7 days of its date")
    expect(text).toContain("within 10 business days of receiving this report")
    expect(text).toContain("7. HOW TO REACH US")
    expect(text).toContain(LENDER.collectionsEmail)
    expect(text).not.toContain("only the months to the termination date count")
    const early = words(inspectionReportClauses({ ...REPORT, origin: "EARLY_TERMINATION", excessUsageCents: null }).map((c) => c.text).join(" "))
    expect(early).toContain("Because the lease ended early, only the months to the termination date count.")
    expect(early).toContain("The excess-usage charge is calculated when the end-of-term invoice is issued")
  })

  it("the report's watermark follows the lender's approval of the wording", async () => {
    expect((await pageTexts(await renderLeaseInspectionReport({ ...REPORT, draft: false }, LENDER))).flat()).not.toContain(DRAFT_WATERMARK)
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

describe("the PDF dates", () => {
  afterEach(() => vi.useRealTimers())

  // pdf-lib rewrites the dates on load unless told not to; read them as written.
  const datesOf = async (bytes: Buffer) => {
    const pdf = await PDFDocument.load(bytes, { updateMetadata: false })
    return [pdf.getCreationDate()?.toISOString(), pdf.getModificationDate()?.toISOString()]
  }

  it.each([
    ["expiry notice", () => renderLeaseExpiryNotice(NOTICE, LENDER), NOTICE.queuedOn],
    ["termination quote", () => renderLeaseTerminationQuote(QUOTE, LENDER), QUOTE.quotedOn],
    ["inspection report", () => renderLeaseInspectionReport(REPORT, LENDER), REPORT.inspectedOn],
  ])("the %s is created and modified on its own day, whatever the clock says", async (_name, render, dayIso) => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(new Date("2031-11-20T15:45:00Z"))
    const first = await render()
    vi.setSystemTime(new Date("2032-05-02T07:00:00Z"))
    const second = await render()
    const expected = `${dayIso}T12:00:00.000Z`
    expect(await datesOf(first)).toEqual([expected, expected])
    expect(sha(second)).toBe(sha(first))
  })
})
