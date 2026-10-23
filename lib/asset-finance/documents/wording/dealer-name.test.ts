import { describe, expect, it } from "vitest"
import { dealerNameProblem, dealerPrintRefusal, documentDealer, MAX_DEALER_NAME } from "./dealer-name"

const at = (code: number) => String.fromCodePoint(code)
// One character class per case, in an otherwise plain name, so each rule is killable on its own.
const inside = (ch: string) => `Mo${ch}tors`
const hex = (code: number) => `U+${code.toString(16).toUpperCase().padStart(4, "0")}`

describe("dealerNameProblem: the shape of a name printed in a labelled field", () => {
  it.each([
    "Highveld Yellow Iron (Pty) Ltd", "Karoo Asset Brokers CC", "O'Brien & Sons", "Smith, Jones and Partners", "4 Wheel Drive Centre",
    "May & Sons", "Price Brothers Plant Hire", "Not Just Tractors", "Zero Fee Motors", "A".repeat(MAX_DEALER_NAME), "Z",
    // Every printable punctuation mark is allowed: the name is data in a field, not part of a sentence.
    "Karoo Plant Hire Pty. Ltd.", 'Smith "Quick" Motors', "Motors; Pretoria", "Motors: Pretoria", "Smith t/a Quick Motors", "Pay-Less Plant",
    "D’Arcy Motors", "Motors (Pty) Ltd.", "A/B Motors", "7-Eleven Trucks",
    // Letters the document font (Windows-1252) prints.
    "Schön Motors", "Škoda Motors", "Café ñandú", "Œuvre Plant",
  ])("accepts %j", (name) => {
    expect(dealerNameProblem(name)).toBeNull()
  })

  it.each<[string, string]>([
    ["an empty name", ""],
    ["more than the maximum", "A".repeat(MAX_DEALER_NAME + 1)],
    ["only spaces", "   "],
    ["a leading space", " Motors"],
    ["a trailing space", "Motors "],
    ["a repeated space", "Mo  tors"],
    ["a no-break space", inside(at(0xa0))],
    ["a soft hyphen", inside(at(0xad))],
    ["a line break", inside("\n")],
    ["a carriage return", inside("\r")],
    ["a tab", inside("\t")],
    ["a NUL", inside(at(0))],
    ["a bell", inside(at(7))],
    ["the last C0 control", inside(at(0x1f))],
    ["DEL", inside(at(0x7f))],
    ["the first C1 control", inside(at(0x80))],
    ["a next-line control", inside(at(0x85))],
    ["the last C1 control", inside(at(0x9f))],
    ...[0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x2060, 0xfeff, 0x2028, 0x2029, 0x202a, 0x202e, 0x2066, 0x2069].map((code) => [`${hex(code)} (invisible or directional)`, inside(at(code))] satisfies [string, string]),
    ["a Latin letter outside Windows-1252 (C with caron)", at(0x10c) + "otors"],
    ["a Latin letter outside Windows-1252 (L with stroke)", at(0x141) + "ot"],
    ["a Latin letter outside Windows-1252 (S with cedilla)", at(0x15e) + "ahin Motors"],
    ["a Greek letter", `${at(0x3a9)} Motors`],
    ["a Cyrillic letter", `${at(0x416)} Motors`],
    ["a CJK character", `Motors ${at(0x4e2d)}`],
    ["an emoji", `Motors ${at(0x1f600)}`],
    ["a combining mark", `a${at(0x301)} Motors`],
    ["a fullwidth letter", `${at(0xff21)}BC Motors`],
  ])("refuses %s", (_, name) => {
    expect(dealerNameProblem(name)).toEqual(expect.any(String))
  })

  it("the problem for a font character does not say 'non-Latin' (Latin letters outside Windows-1252 are refused too)", () => {
    expect(dealerNameProblem(at(0x10c) + "otors")).not.toMatch(/non-Latin/i)
  })
})

describe("dealerPrintRefusal and documentDealer", () => {
  it("names the document, not an agreement, and quotes the name escaped", () => {
    const refusal = dealerPrintRefusal("Mo­tors")
    expect(refusal).toMatch(/cannot be printed on the document/)
    expect(refusal).not.toMatch(/agreement/i)
    expect(refusal).toContain("Mo\\u00adtors")
    expect(dealerPrintRefusal("Highveld Yellow Iron (Pty) Ltd")).toBeNull()
  })

  it("maps a stored dealer to the document's dealer, or none", () => {
    expect(documentDealer(null)).toBeNull()
    expect(documentDealer(undefined)).toBeNull()
    expect(documentDealer({ name: "Karoo", kind: "BROKER", contactEmail: "x@y.invalid" } as { name: string; kind: "BROKER" })).toEqual({ name: "Karoo", kind: "BROKER" })
  })
})
