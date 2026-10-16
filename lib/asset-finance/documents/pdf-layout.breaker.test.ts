import { PDFDocument, StandardFonts } from "pdf-lib"
import { describe, expect, it } from "vitest"
import { wrapText } from "./pdf-layout"

const W = 300
async function font() {
  const doc = await PDFDocument.create()
  return doc.embedFont(StandardFonts.Helvetica)
}
const fits = (f: Awaited<ReturnType<typeof font>>, lines: string[]) => lines.every((l) => f.widthOfTextAtSize(l, 9) <= W)

describe("REPRO F1: wrapText newline handling", () => {
  it("splits CRLF, trailing LF without stray lines or '?'", async () => {
    const f = await font()
    expect(wrapText("a\r\nb\r\n", f, 9, W)).toEqual(["a", "b"])
    expect(wrapText("a\nb\n", f, 9, W)).toEqual(["a", "b"])
  })
  it("F1-a: a lone CR (old-Mac / pasted) must be a line break, not '?'", async () => {
    const f = await font()
    const out = wrapText("Line one\rLine two", f, 9, W)
    expect(out.join("|")).not.toContain("?")
  })
  it("F1-b: U+2028/U+0085 line separators must break, not print '?'", async () => {
    const f = await font()
    const out = wrapText("Line one Line two\u0085Line three", f, 9, W)
    expect(out.join("|")).not.toContain("?")
  })
  it("F1-e: long second line after split wraps within width", async () => {
    const f = await font()
    const out = wrapText(`a\n${"word ".repeat(80)}`, f, 9, W)
    expect(out.length).toBeGreaterThan(2)
    expect(fits(f, out)).toBe(true)
  })
  it("F1-f: emoji / non-WinAnsi in a multi-line value neither throws nor drops a line", async () => {
    const f = await font()
    const out = wrapText("Ŝtreet 1 😀\nTown ŝ\n李明", f, 9, W)
    expect(out).toHaveLength(3)
    for (const l of out) expect(() => f.widthOfTextAtSize(l, 9)).not.toThrow()
  })
  it("F1-g: tab and NBSP separators", async () => {
    const f = await font()
    const out = wrapText("a\tb c", f, 9, W)
    expect(out.join("|")).not.toContain("?")
  })
})
