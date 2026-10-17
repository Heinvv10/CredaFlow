import { expect } from "vitest"
import { pdfPageContents } from "@/lib/pdf/__tests__/pdf-test-utils"
import { DRAFT_WATERMARK, PLACEHOLDER_CLAUSE } from "../pdf-layout"

const CP1252_HIGH = "€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008dŽ\u008f\u0090‘’“”•–—˜™š›œ\u009džŸ"
const winAnsi = (hex: string) => [...Buffer.from(hex, "hex")].map((b) => b >= 0x80 && b <= 0x9f ? CP1252_HIGH[b - 0x80] : String.fromCharCode(b)).join("")

/** Every text run the PDF draws, in drawing order. */
export const texts = async (bytes: Buffer) => (await pdfPageContents(bytes)).flatMap((content) => [...content.matchAll(/<([0-9A-Fa-f]+)> Tj/g)].map((m) => winAnsi(m[1])))

/** The printed wording, wrapped lines joined back into sentences. */
export const prose = (lines: string[]) => lines.join(" ")

/**
 * No placeholder, and each clause heading prints as "<n> <heading>" in order,
 * directly followed by its own wording, which starts "<n>.1 ".
 */
export function expectWordedClauses(lines: string[], headings: readonly string[]): void {
  expect(lines).not.toContain(PLACEHOLDER_CLAUSE)
  expect(prose(lines)).not.toContain("Placeholder")
  let from = 0
  headings.forEach((heading, i) => {
    const at = lines.indexOf(`${i + 1} ${heading}`, from)
    expect(at, heading).toBeGreaterThanOrEqual(from)
    expect(lines[at + 1], heading).toMatch(new RegExp(`^${i + 1}\\.1 \\S`))
    from = at + 1
  })
}

/** Unapproved: the DRAFT watermark and subtitle print. Approved: neither does. */
export function expectDraftMarks(lines: string[], approved: boolean): void {
  const draft = prose(lines).includes("DRAFT")
  expect(lines.includes(DRAFT_WATERMARK)).toBe(!approved)
  expect(draft).toBe(!approved)
}
