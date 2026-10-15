import { describe, expect, it } from "vitest"
import { canonicalIdentifier, nameTokens, screenBuyer, type ScreeningCandidates } from "./recovery-screening"

// Every variant below is a way the edge-case tester wrote a related buyer to
// slip past the screening. Synthetic values only.
const ID = "8001015009087"
const director = "Test Director"
const asId = (shift: number) => [...ID].map((c) => String.fromCharCode(c.charCodeAt(0) + shift)).join("")

const flagged = (buyer: { name?: string; identifier?: string }, candidates: ScreeningCandidates[]) =>
  screenBuyer({ name: buyer.name ?? "Zzyzx Stranger", identifier: buyer.identifier ?? "ZZ-OTHER-1" }, candidates).match
const person = (name: string, kind: ScreeningCandidates["kind"] = "RELATED_PARTY"): ScreeningCandidates => ({ kind, names: [name], people: [name], identifiers: [] })
const holder = (identifier: string): ScreeningCandidates => ({ kind: "BORROWER", names: [], identifiers: [identifier] })

describe("identifier variants", () => {
  it.each([
    ["spaces", `${ID.slice(0, 6)} ${ID.slice(6, 10)} ${ID.slice(10)}`],
    ["dashes", `${ID.slice(0, 6)}-${ID.slice(6, 10)}-${ID.slice(10)}`],
    ["a label and lower case", `id: ${ID}`],
    ["a trailing zero-width space", `${ID}​`],
    ["fullwidth digits", asId(0xfee0)],
    ["Arabic-Indic digits", asId(0x630)],
    ["Devanagari digits", asId(0x966 - 0x30)],
    ["a leading apostrophe and tab", `'\t${ID}`],
    ["a trailing label", `${ID} ID`],
  ])("flags the ID written with %s", (_label, written) => {
    expect(flagged({ identifier: written }, [holder(ID)])).toBe(true)
  })

  it("does not flag a different ID or a partial ID (an ID the field merely contains is flagged: see the round 2 file)", () => {
    expect(flagged({ identifier: "8001015009088" }, [holder(ID)])).toBe(false)
    expect(flagged({ identifier: "800101500908" }, [holder(ID)])).toBe(false)
  })

  describe("CIPC registration numbers", () => {
    const registration = "2098/100005/05"
    it.each([
      ["exact", "2098/100005/05"],
      ["no slashes", "20981000050" + "5"],
      ["spaces around the slashes", "2098 / 100005 / 05"],
      ["lower case with a CK prefix", "ck2098/100005/05"],
      ["the suffix without its leading zero", "2098/100005/5"],
      ["fullwidth digits", "２０９８／１００００５／０５"],
    ])("flags %s", (_label, written) => {
      expect(flagged({ identifier: written }, [holder(registration)])).toBe(true)
    })

    it("treats a registration number held without its zero the same way", () => {
      expect(flagged({ identifier: "2098/100005/05" }, [holder("CK 2098/100005/5")])).toBe(true)
    })

    it("does not flag another company number or a different suffix", () => {
      expect(flagged({ identifier: "2098/100006/05" }, [holder(registration)])).toBe(false)
      expect(flagged({ identifier: "2098/100005/07" }, [holder(registration)])).toBe(false)
      expect(flagged({ identifier: "2098/100005" }, [holder(registration)])).toBe(false)
    })

    it("canonicalises a registration number to year, number and suffix as a number", () => {
      expect(canonicalIdentifier("CK2098/100005/05")).toBe("2098100005" + "5")
      expect(canonicalIdentifier("2098/100005/10")).toBe("209810000510")
      expect(canonicalIdentifier("ab-12 c")).toBe("AB12C")
    })
  })

  it("flags an ID inside a COI declaration written in any of those ways", () => {
    const coi: ScreeningCandidates = { kind: "COI_DECLARATION", names: [], identifiers: [], freeText: [`Director of ${asId(0xfee0)} (Pty) Ltd, also 2098 / 100005 / 5`] }
    expect(flagged({ identifier: ID }, [coi])).toBe(true)
    expect(flagged({ identifier: "ck2098/100005/05" }, [coi])).toBe(true)
  })
})

describe("name variants", () => {
  it.each([
    ["upper case with extra spaces", `  ${director.toUpperCase().replace(" ", "   ")} `],
    ["surname first", "Director Test"],
    ["surname first with a comma", "Director, Test"],
    ["a middle initial", "Test J Director"],
    ["an initial only", "T Director"],
    ["an initial with a full stop", "T. Director"],
    ["diacritics", "Tést Dîrector"],
    ["the two words run together", "TestDirector"],
    ["a title", "Mr Test Director"],
    ["a Dr title with a full stop", "Dr. Test Director"],
    ["a trading name", "Test Director Trading (Pty) Ltd"],
    ["trading as", "Test Director trading as Zzyzx Plant"],
    ["a company suffix", "Test Director (Pty) Ltd"],
  ])("flags the director written with %s", (_label, written) => {
    expect(flagged({ name: written }, [person(director)])).toBe(true)
  })

  it("does not flag a different person, or the same surname with another first initial", () => {
    expect(flagged({ name: "Samuel Director" }, [person(director)])).toBe(false)
    expect(flagged({ name: "Test Directory" }, [person(director)])).toBe(false)
    expect(flagged({ name: "Test" }, [person(director)])).toBe(false)
  })

  it("flags only the exact set of words for a company, not a probable match", () => {
    const company: ScreeningCandidates = { kind: "BORROWER", names: ["TEST Hauliers 123 (Pty) Ltd"], identifiers: [] }
    for (const written of ["TEST Hauliers 123", "Test Hauliers 123 Pty Ltd", "TEST HAULIERS 123 (PROPRIETARY) LIMITED", "Test Hauliers 123 Proprietary Limited", "Hauliers 123 TEST (PTY)LTD"]) {
      expect(flagged({ name: written }, [company]), written).toBe(true)
    }
    expect(flagged({ name: "Test Hauliers 456" }, [company])).toBe(false)
    expect(flagged({ name: "Tim Hauliers" }, [company])).toBe(false)
  })

  describe("staff", () => {
    const staff = (name: string) => person(name, "STAFF")
    it.each([
      ["the exact name", "Thandiwe Nkosi-Mokoena", "Thandiwe Nkosi-Mokoena"],
      ["the hyphen as a space", "Thandiwe Nkosi-Mokoena", "Thandiwe Nkosi Mokoena"],
      ["surname first", "Thandiwe Nkosi-Mokoena", "Nkosi-Mokoena Thandiwe"],
      ["surname first with a comma", "Thandiwe Nkosi-Mokoena", "Nkosi-Mokoena, Thandiwe"],
      ["an initial and the surname", "Thandiwe Nkosi-Mokoena", "T Nkosi-Mokoena"],
      ["a diacritic", "Pieter van der Merwe", "Pieter van der Merwé"],
      ["the particle run together", "Pieter van der Merwe", "Pieter vander Merwe"],
      ["the whole surname run together", "Pieter van der Merwe", "Pieter vandermerwe"],
      ["the case changed", "Pieter van der Merwe", "pieter VAN DER merwe"],
      ["the particle held run together", "Pieter vander Merwe", "Pieter van der Merwe"],
      ["an initial and the particle surname", "Pieter van der Merwe", "P van der Merwe"],
      ["an apostrophe", "Sean O'Brien", "Sean OBrien"],
    ])("flags %s", (_label, held, written) => {
      expect(flagged({ name: written }, [staff(held)])).toBe(true)
    })

    it("does not flag a colleague with another surname", () => {
      expect(flagged({ name: "Pieter van der Berg" }, [staff("Pieter van der Merwe")])).toBe(false)
      expect(flagged({ name: "Thandiwe Nkosi" }, [staff("Thandiwe Nkosi-Mokoena")])).toBe(false)
    })
  })

  it("reads a COI declaration's names with the same folding, in order", () => {
    const coi: ScreeningCandidates = { kind: "COI_DECLARATION", names: [], identifiers: [], freeText: ["My cousin Mr Tést Director bids at auctions"] }
    expect(flagged({ name: "Test Director" }, [coi])).toBe(true)
    expect(flagged({ name: "Director Test" }, [coi])).toBe(false)
  })
})

describe("nameTokens", () => {
  it("drops titles and company words, folds marks and case, and joins particles to the word after them", () => {
    expect(nameTokens("Prof. Pieter van der Merwé trading as Acme (Pty) Ltd")).toEqual(["pieter", "vandermerwe", "acme"])
    expect(nameTokens("Adv De la Rey")).toEqual(["delarey"])
    expect(nameTokens("T/A  Mrs O’Neil CC")).toEqual(["oneil"])
  })
})
