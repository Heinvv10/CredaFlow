import { describe, expect, it } from "vitest"
import { asciiDigit, DIGIT_BLOCK_STARTS } from "./recovery-digit-blocks"
import { canonicalIdentifier, nameTokens } from "./recovery-screening"

// The list of digit blocks is the one the SQL recoveryAsciiDigits is generated from
// (recovery-rules-identifier.integration.test.ts holds the two to each other).
describe("the Unicode decimal digits the screening reads as ASCII", () => {
  it("lists every block in ascending order, ten digits each, none twice", () => {
    expect([...DIGIT_BLOCK_STARTS]).toEqual([...DIGIT_BLOCK_STARTS].sort((a, b) => a - b))
    expect(new Set(DIGIT_BLOCK_STARTS).size).toBe(DIGIT_BLOCK_STARTS.length)
    for (const start of DIGIT_BLOCK_STARTS) for (let digit = 0; digit < 10; digit++) expect(asciiDigit(start + digit)).toBe(String(digit))
  })

  it("knows every decimal digit of this runtime's Unicode: a newer Unicode asks for a new block here and in the migration", () => {
    const missing: string[] = []
    for (let cp = 0x80; cp < 0x110000; cp++) {
      const char = String.fromCodePoint(cp)
      if (/^\p{Nd}$/u.test(char) && asciiDigit(cp) === null) missing.push(`U+${cp.toString(16).toUpperCase()}`)
    }
    expect(missing).toEqual([])
  })

  it.each([
    ["Adlam", 0x1e950], ["Ol Onal (Unicode 16)", 0x1e5f1], ["Garay (Unicode 16)", 0x10d40], ["Kawi", 0x11f50], ["Nag Mundari", 0x1e4f0],
  ])("reads the %s digits as ASCII", (_name, zero) => {
    expect([...Array(10).keys()].map((d) => asciiDigit(zero + d)).join("")).toBe("0123456789")
  })

  it("makes the same key of an ID in any of them", () => {
    const id = "8001015009087"
    for (const start of DIGIT_BLOCK_STARTS) {
      expect(canonicalIdentifier([...id].map((c) => String.fromCodePoint(start + Number(c))).join(""))).toBe(id)
    }
  })
})

describe("a name's marks come off before look-alikes fold (item 12)", () => {
  it.each([
    ["a Greek omicron with tonos", "Tést Dirεctόr", "test director"],
    ["a Cyrillic io", "Tёst Director", "test director"],
    ["a Greek alpha with tonos and a Cyrillic a", "Mάrtin", "martin"],
    ["a Cyrillic i with diaeresis", "Prїvate", "private"],
    ["a dotless i", "Dırector", "director"],
    ["a capital dotted I", "İnvest", "invest"],
  ])("reads %s as Latin", (_name, written, bare) => {
    expect(nameTokens(written).join(" ")).toBe(bare)
  })
})
