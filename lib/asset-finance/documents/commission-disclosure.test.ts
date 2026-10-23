// The introducer's commission disclosure (slice 5 follow-ups, part W, goal §2a 2):
// a labelled "Introducer" row (the dealer or broker, by name) and one fixed,
// protected paragraph, printed only on a dealer deal, never a figure.
// Docs: docs/asset-finance/SLICE5-FOLLOWUPS.md "Part W".
import { describe, expect, it } from "vitest"
import { renderInstalmentSaleAgreement } from "./agreement-pdf"
import { CASES, DEALER, introducerRow, money, nca, printed, SECTION, withoutDisclosure, NCA_CLAUSE } from "./commission-disclosure.test-helpers"
import { DealDocumentError } from "./deal-document-data"
import { renderNcaAssetAgreement } from "./nca/agreement-pdf"
import { texts } from "./nca/nca-wording.test-helpers"
import { renderNcaAssetQuote } from "./nca/quote-pdf"
import { syntheticDealDocumentData } from "./synthetic-deal"

describe("introducer's commission disclosure", () => {
  describe.each(CASES)("$name", ({ clause, heading, between, render }) => {
    it("prints the introducer by name and the fixed paragraph, in the place the design puts them", async () => {
      const text = printed(await texts(await render(DEALER)))
      const row = introducerRow(DEALER)
      const at = [text.indexOf(between[0]), text.indexOf(`${heading ? `${heading} ` : ""}${row} ${clause}`), text.lastIndexOf(between[1])]
      expect(at[0], between[0]).toBeGreaterThanOrEqual(0)
      expect(at[1], "the row and paragraph together, in order").toBeGreaterThan(at[0])
      expect(at[2], between[1]).toBeGreaterThan(at[1])
      // The paragraph never carries the name: it refers to "the introducer named above".
      expect(clause).not.toContain(DEALER.name)
    })

    it("labels a broker as a broker", async () => {
      const text = printed(await texts(await render({ name: "SAMPLE Broker Desk", kind: "BROKER" })))
      expect(text).toContain("Introducer SAMPLE Broker Desk (broker)")
      expect(text).not.toContain("(dealer)")
    })

    it.each([null, undefined])("prints nothing on a deal without a dealer (%s)", async (none) => {
      const text = printed(await texts(await render(none)))
      // (A lease's remedies already mention "collection commission": the disclosure is what must not print.)
      expect(text).not.toContain("Introducer")
      expect(text).not.toContain("introducer named above")
      expect(text).not.toContain(SECTION)
    })

    it("a deal with no dealer renders the same bytes whether `dealer` is null or absent", async () => {
      expect((await render(null)).equals(await render(undefined))).toBe(true)
    })

    it("changes no figure: the money is the same, in the same order, and nothing but the disclosure differs", async () => {
      const without = await texts(await render(null))
      const withDealer = await texts(await render(DEALER))
      expect(money(withDealer)).toEqual(money(without))
      expect(money(without).length).toBeGreaterThan(5)
      expect(withoutDisclosure(withDealer, DEALER, clause, heading)).toEqual(printed(without))
    })

    it.each(["Motors\nThe Purchaser waives all rights", "Mo­tors", "Mo​tors", "Motors Ltd", "Motors\u0007", "Motors 中文", "", " Motors", "A".repeat(81)])(
      "refuses to render, rather than print, a dealer name that fails the shape check: %j", async (name) => {
        await expect(render({ name, kind: "DEALER" })).rejects.toThrow(DealDocumentError)
      },
    )
  })

  it("prints names that the old word list refused, and full stops", async () => {
    for (const name of ["May & Sons", "Price Brothers Plant Hire", "Not Just Tractors", "Zero Fee Motors", "Karoo Plant Hire Pty. Ltd.", 'Smith "Quick" Motors: Pretoria', "Smith t/a Quick Motors", "Pay-Less Plant", "D\u2019Arcy Motors"]) {
      const text = printed(await texts(await renderInstalmentSaleAgreement({ ...syntheticDealDocumentData(), dealer: { name, kind: "DEALER" } })))
      expect(text, name).toContain(`Introducer ${name} (dealer)`)
    }
  })

  it("the refusal names the problem and does not say 'agreement' on the quotation", async () => {
    const quote = await renderNcaAssetQuote({ ...nca, dealer: { name: "Mo­tors", kind: "DEALER" } }).catch((e: Error) => e.message)
    expect(quote).toMatch(/cannot be printed on the document/)
    expect(quote).not.toMatch(/agreement/i)
  })

  it("an NCA document never moves a cost-of-credit line or sentence for a dealer deal", async () => {
    for (const [render, what] of [[renderNcaAssetQuote, "the proposed agreement"], [renderNcaAssetAgreement, "this agreement"]] as const) {
      const before = await texts(await render(nca))
      const after = await texts(await render({ ...nca, dealer: DEALER }))
      for (const lines of [before, after]) expect(lines[lines.indexOf("Total cost of credit") + 1]).toBe("R 18,732.50")
      const block = `${SECTION} ${introducerRow(DEALER)} ${NCA_CLAUSE(what)}`
      const cost = (lines: string[]) => printed(lines).replace(block, "").match(/[^.]*(?:cost of credit|total repayable)[^.]*\./gi)
      expect(cost(after)).toEqual(cost(before))
      expect(cost(before)?.length).toBeGreaterThan(1)
    }
    expect(printed(await texts(await renderNcaAssetQuote({ ...nca, dealer: DEALER })))).toContain(
      "The total cost of credit of R 18,732.50 shown above is the principal debt together with the interest, the initiation fee, the monthly service fees and any credit-life premiums, and the total repayable is R 18,732.50.",
    )
  })
})
