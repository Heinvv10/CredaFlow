import { describe, expect, it } from "vitest"
import { identifierKeys, nameTokens, screenBuyer, type ScreeningCandidates } from "./recovery-screening"

// Round 2 of the edge-case tester (R3a, R3b): an ID hidden inside a longer
// field, typed with letters for digits or split by a label, and a name spelt
// with look-alike letters or run together. Synthetic values only. Typos, a
// business named after the surname only, two-digit years and the content of
// evidence files are out of scope (documented as the boundary).
const ID = "8001015009087"
const OTHER_ID = "7001015800084"
const holder = (identifier: string): ScreeningCandidates => ({ kind: "BORROWER", names: [], identifiers: [identifier] })
const idFlagged = (identifier: string, held = ID) => screenBuyer({ name: "Zzyzx Stranger", identifier }, [holder(held)]).match
const person = (name: string): ScreeningCandidates => ({ kind: "RELATED_PARTY", names: [name], people: [name], identifiers: [] })
const nameFlagged = (buyer: string, candidate = "Test Director") => screenBuyer({ name: buyer, identifier: "ZZ-OTHER-9" }, [person(candidate)]).match

describe("an identifier hidden in the buyer's identifier field (R3a)", () => {
  it.each([
    ["a label in the middle", `${ID.slice(0, 4)} ID ${ID.slice(4)}`],
    ["the letter O for zero", ID.replace("0", "O").replace("0", "o")],
    ["the letter l and I for one", ID.replaceAll("1", "l")],
    ["two IDs in the field", `${OTHER_ID} / ${ID}`],
    ["an appended digit", `${ID}0`],
    ["a prepended digit", `1${ID}`],
    ["a 27 prefix", `27${ID}`],
    ["a +27 prefix", `+27 ${ID}`],
    ["a newline in the middle", `${ID.slice(0, 6)}\n${ID.slice(6)}`],
    ["RTL marks", `‏${ID}‎`],
    ["superscript digits", [...ID].map((c) => "⁰¹²³⁴⁵⁶⁷⁸⁹"[Number(c)]).join("")],
    ["circled digits", [...ID].map((c) => (c === "0" ? "⓪" : String.fromCodePoint(0x2460 + Number(c) - 1))).join("")],
    ["a trailing label", `${ID} (SA ID)`],
    ["an RSA prefix", `RSA ${ID}`],
    ["text on both sides", `Passport-less citizen ${ID} per affidavit`],
  ])("flags the borrower's ID behind %s", (_label, written) => {
    expect(idFlagged(written)).toBe(true)
  })

  it("flags a registration number inside a longer field, however its segments are padded", () => {
    expect(idFlagged("Reg No: 2098/12345/05, Zed Hauliers", "2098/012345/05")).toBe(true)
    expect(idFlagged("K2098/123456/05 (Pty) Ltd", "2098/123456/5")).toBe(true)
    expect(idFlagged("our company number is 2098 123456 05 as registered", "CK2098/123456/05")).toBe(true)
    expect(idFlagged("2098/123456/07", "2098/123456/05")).toBe(false)
  })

  it("does not flag what is not that ID: another ID, part of it, an ID with one digit changed", () => {
    expect(idFlagged(OTHER_ID)).toBe(false)
    expect(idFlagged(ID.slice(0, 12))).toBe(false)
    expect(idFlagged(ID.slice(1))).toBe(false)
    expect(idFlagged(`${ID.slice(0, 12)}8`)).toBe(false)
    expect(idFlagged("ID NUMBER ON FILE")).toBe(false)
    expect(idFlagged("")).toBe(false)
  })

  it("holds the canonical key, the digit runs, the 13-digit windows and the 11/12-digit registration forms, sorted", () => {
    const keys = identifierKeys(`${OTHER_ID} / 27${ID}`)
    expect(keys).toEqual([...keys].sort())
    expect(keys).toEqual(expect.arrayContaining([OTHER_ID, `27${ID}`, ID, `${OTHER_ID}27${ID}`.slice(0, 13)]))
    expect(identifierKeys("2098/12345/05")).toEqual(expect.arrayContaining(["20980123455"]))
    expect(identifierKeys("")).toEqual([])
  })
})

describe("a name spelt past the comparison (R3b)", () => {
  const cyrillic = (name: string) => name.replace(/a/g, "а").replace(/e/g, "е").replace(/o/g, "о").replace(/i/g, "і").replace(/c/g, "с").replace(/T/g, "Т")
  it.each([
    ["Cyrillic look-alikes", cyrillic("Test Director")],
    ["Greek look-alikes", "Τεst Dirεctor".replace("Τ", "Τ").replace(/o/g, "ο")],
    ["Cyrillic look-alikes in the surname only", `Test ${cyrillic("Director")}`],
    ["initial and surname run together", "TDirector"],
    ["first name and surname run together", "TestDirector"],
    ["surname and initial run together", "DirectorT"],
    ["a joined name among other words", "Mr TDirector and Sons Trading"],
    ["zero-width characters inside", "Test Dir​ector"],
    ["a soft hyphen inside", "Test Dir­ector"],
    ["Cyrillic and joined", cyrillic("TDirector")],
  ])("flags Test Director behind %s", (_label, written) => {
    expect(nameFlagged(written)).toBe(true)
  })

  it("does not flag another person, or a joined name that is not theirs", () => {
    expect(nameFlagged("TDirectory")).toBe(false)
    expect(nameFlagged("SDirector")).toBe(false)
    expect(nameFlagged(cyrillic("Sam Smith"))).toBe(false)
  })

  it("reads look-alike letters as Latin before tokenising", () => {
    expect(nameTokens("Тест Дирeктор")).not.toEqual(nameTokens("Test Director")) // real Cyrillic words, not look-alikes
    expect(nameTokens(cyrillic("Test Director"))).toEqual(["test", "director"])
  })

  it("applies the joined forms to natural persons only", () => {
    const company: ScreeningCandidates = { kind: "RELATED_PARTY", names: ["Test Director"], identifiers: [] }
    expect(screenBuyer({ name: "TDirector", identifier: "ZZ-OTHER-9" }, [company]).match).toBe(false)
  })
})
