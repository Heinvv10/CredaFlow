import { describe, expect, it } from "vitest"
import { normaliseIdentifier, screenBuyer } from "./recovery-screening"

// Synthetic values only.
const buyer = { name: "Thandi  Example", identifier: "2015/123456/07" }
const none = { names: [], identifiers: [] }

describe("normaliseIdentifier", () => {
  it("strips everything but letters and digits and upper-cases", () => {
    expect(normaliseIdentifier(" 2015/123456/07 ")).toBe("201512345607")
    expect(normaliseIdentifier("ab-12 c")).toBe("AB12C")
    expect(normaliseIdentifier("---")).toBe("")
  })
})

describe("screenBuyer", () => {
  it("no candidates, no match", () => {
    expect(screenBuyer(buyer, [])).toEqual({ match: false, matches: [] })
    expect(screenBuyer(buyer, [{ kind: "STAFF", ...none }])).toEqual({ match: false, matches: [] })
  })

  it("matches a name regardless of case, spacing and punctuation", () => {
    const result = screenBuyer(buyer, [{ kind: "STAFF", names: ["THANDI EXAMPLE"], identifiers: [] }])
    expect(result).toEqual({ match: true, matches: [{ kind: "STAFF", on: "NAME" }] })
    expect(screenBuyer(buyer, [{ kind: "STAFF", names: ["thandi. example"], identifiers: [] }]).match).toBe(true)
  })

  it("matches an identifier regardless of formatting", () => {
    const result = screenBuyer(buyer, [{ kind: "BORROWER", names: [], identifiers: ["201512345607"] }])
    expect(result).toEqual({ match: true, matches: [{ kind: "BORROWER", on: "IDENTIFIER" }] })
  })

  it("does not match a different name or a partial identifier", () => {
    expect(screenBuyer(buyer, [{ kind: "RELATED_PARTY", names: ["Thandi Examples", "Thandi"], identifiers: ["2015123456"] }]).match).toBe(false)
  })

  it("an empty buyer name or identifier never matches empty candidates", () => {
    const blank = { name: " ", identifier: "--" }
    expect(screenBuyer(blank, [{ kind: "STAFF", names: ["", " "], identifiers: ["", "/"], freeText: ["anything"] }])).toEqual({ match: false, matches: [] })
  })

  it("reports each kind and dimension that matched, never the values", () => {
    const result = screenBuyer(buyer, [
      { kind: "BORROWER", names: ["Thandi Example"], identifiers: ["201512345607"] },
      { kind: "STAFF", names: ["Thandi Example"], identifiers: [] },
      { kind: "RELATED_PARTY", names: ["Other Person"], identifiers: [] },
    ])
    expect(result.match).toBe(true)
    expect(result.matches).toEqual([
      { kind: "BORROWER", on: "NAME" },
      { kind: "BORROWER", on: "IDENTIFIER" },
      { kind: "STAFF", on: "NAME" },
    ])
    expect(JSON.stringify(result)).not.toMatch(/Thandi|2015/i)
  })

  describe("free text (COI declarations)", () => {
    const coi = (...freeText: string[]) => screenBuyer(buyer, [{ kind: "COI_DECLARATION", ...none, freeText }])

    it("matches the name as a whole token sequence inside the text", () => {
      expect(coi("My brother-in-law, thandi example, bids at auctions").matches).toEqual([{ kind: "COI_DECLARATION", on: "NAME" }])
    })

    it("matches the identifier however the declarant spaced or punctuated it", () => {
      expect(coi("Director of 2015/123456/07 (Pty) Ltd").matches).toEqual([{ kind: "COI_DECLARATION", on: "IDENTIFIER" }])
      expect(coi("reg 2015 123456 07").match).toBe(true)
    })

    it("does not match inside a longer word or token", () => {
      expect(coi("Thandi Examples is unrelated").match).toBe(false)
      expect(coi("Mthandi Example").match).toBe(false)
      expect(coi("ref 12015/123456/07").match).toBe(false)
      expect(coi("ref 2015/123456/078").match).toBe(false)
    })

    it("needs the name tokens in order and adjacent", () => {
      expect(coi("Example, Thandi").match).toBe(false)
      expect(coi("Thandi X Example").match).toBe(false)
    })

    it("reports both dimensions when text carries both", () => {
      expect(coi("Thandi Example, 2015/123456/07").matches).toEqual([
        { kind: "COI_DECLARATION", on: "NAME" },
        { kind: "COI_DECLARATION", on: "IDENTIFIER" },
      ])
    })
  })
})
