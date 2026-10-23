// Edge tester W round 2: wrapText breaking over-long words.
import { PDFDocument, StandardFonts } from "pdf-lib"
import { describe, expect, it } from "vitest"
import { wrapText } from "./pdf-layout"

const font = async () => (await PDFDocument.create()).embedFont(StandardFonts.Helvetica)

describe("edge-w wrapText", () => {
  it("breaks an over-long word into lines that fit and lose no character", async () => {
    const f = await font()
    for (const word of ["W".repeat(80), "MW".repeat(40), "Wilhelmina".repeat(8), "i".repeat(300)]) {
      for (const max of [300, 120, 40]) {
        const lines = wrapText(`${word} (dealer)`, f, 9, max)
        for (const l of lines) expect(f.widthOfTextAtSize(l, 9), l).toBeLessThanOrEqual(max + 0.001)
        expect(lines.join("").replace(/ /g, "")).toBe(`${word}(dealer)`)
      }
    }
  })
  it("a word exactly at the width stays whole; one char more breaks", async () => {
    const f = await font()
    const w = f.widthOfTextAtSize("MMMMM", 9)
    expect(wrapText("MMMMM", f, 9, w)).toEqual(["MMMMM"])
    expect(wrapText("MMMMMM", f, 9, w).join("")).toBe("MMMMMM")
    expect(wrapText("MMMMMM", f, 9, w).length).toBe(2)
  })
  it("a column narrower than one character terminates, one char per line, nothing lost", async () => {
    const f = await font()
    const lines = wrapText("WWWW ab", f, 9, 1)
    expect(lines.join("")).toBe("WWWWab")
    expect(wrapText("", f, 9, 1)).toEqual([])
  })
  it("normal prose and short words wrap exactly as before (greedy)", async () => {
    const f = await font()
    const text = "The quick brown fox jumps over the lazy dog and keeps running far away"
    const lines = wrapText(text, f, 9, 150)
    expect(lines.join(" ")).toBe(text)
    for (const l of lines) expect(f.widthOfTextAtSize(l, 9)).toBeLessThanOrEqual(150)
  })
  it("a long word after text starts a fresh line; short text after it continues on the last piece", async () => {
    const f = await font()
    const lines = wrapText(`hello ${"W".repeat(40)} tail`, f, 9, 100)
    expect(lines[0]).toBe("hello")
    expect(lines.at(-1)).toMatch(/ tail$/)
  })
  it("a sanitised word (non-Latin to ?) is measured after sanitising", async () => {
    const f = await font()
    for (const l of wrapText("中".repeat(100), f, 9, 50)) expect(f.widthOfTextAtSize(l, 9)).toBeLessThanOrEqual(50)
  })
})
