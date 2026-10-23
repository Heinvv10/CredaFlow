// Edge tester W: an unbreakable long name must stay inside the page (wrapText never splits a word).
import { PDFDocument, StandardFonts } from "pdf-lib"
import { describe, expect, it } from "vitest"
import { introducerRow } from "./wording/commission-disclosure"
import { wrapText } from "./pdf-layout"

const PAGE_W = 595.28
const MARGIN = 50 // asserted below against the real constant
describe("edge-w introducer value width", () => {
  it.each([["W".repeat(80)], ["MW".repeat(40)], ["Wilhelmina".repeat(8)], ["Konstantinopoulos-Papadopoulos-Constantinides-Hjalmarsson"]])(
    "%s fits between the value column and the right page edge", async (name) => {
      const doc = await PDFDocument.create()
      const font = await doc.embedFont(StandardFonts.Helvetica)
      const [, value] = introducerRow({ name, kind: "DEALER" })
      const lines = wrapText(value, font, 9, PAGE_W - 2 * MARGIN - 170)
      const widest = Math.max(...lines.map((l) => font.widthOfTextAtSize(l, 9)))
      expect(MARGIN + 170 + widest, JSON.stringify(lines)).toBeLessThanOrEqual(PAGE_W - MARGIN + 0.5)
    })
})
