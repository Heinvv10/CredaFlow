import { PDFDocument, StandardFonts } from "pdf-lib"
import { describe, expect, it } from "vitest"
import { wrapText } from "./pdf-layout"

const MAX = 300
async function font() {
  return (await PDFDocument.create()).embedFont(StandardFonts.Helvetica)
}

describe("wrapText", () => {
  it("cuts a word wider than the line, so no line is wider than the line, and loses no character", async () => {
    const f = await font()
    for (const word of ["W".repeat(80), "MW".repeat(40), "Wilhelmina".repeat(8)]) {
      const lines = wrapText(`Intro ${word} outro`, f, 9, MAX)
      expect(Math.max(...lines.map((l) => f.widthOfTextAtSize(l, 9)))).toBeLessThanOrEqual(MAX)
      expect(lines.join("").replace(/ /g, "")).toBe(`Intro${word}outro`)
      expect(lines.length).toBeGreaterThan(2)
    }
  })

  it("leaves ordinary text exactly as before: words kept whole, wrapped at spaces", async () => {
    const f = await font()
    const text = "The Seller may pay a commission to the introducer named above, which introduced the Purchaser to the Seller for this Agreement."
    const lines = wrapText(text, f, 9, MAX)
    expect(lines.join(" ")).toBe(text)
    expect(Math.max(...lines.map((l) => f.widthOfTextAtSize(l, 9)))).toBeLessThanOrEqual(MAX)
  })

  it("a word that exactly fits stays whole", async () => {
    const f = await font()
    const word = "W".repeat(10)
    expect(wrapText(word, f, 9, f.widthOfTextAtSize(word, 9))).toEqual([word])
  })
})
