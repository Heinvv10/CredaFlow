import { describe, expect, it } from "vitest"
import { canonicalIdentifier, screenBuyer, type ScreeningCandidates } from "./recovery-screening"

// A CIPC registration number written with separators is read segment by
// segment, so the padding of its middle segment is not significant; written as
// a run of digits it is read as year, six digits and the suffix. The SQL
// recoveryIdentifierKey is held to the same keys by
// recovery-rules-identifier.integration.test.ts. Synthetic values only.
const holder = (identifier: string): ScreeningCandidates => ({ kind: "BORROWER", names: [], identifiers: [identifier] })
const flagged = (identifier: string, held: string) => screenBuyer({ name: "Zzyzx Stranger", identifier }, [holder(held)]).match

describe("registration numbers written with separators", () => {
  it.each([
    ["2098/012345/05"], ["2098/12345/05"], ["2098 / 12345 / 5"], ["CK 2098-12345-05"], ["2098_012345_05"], ["Reg 2098/12345/05"], ["2098/12345/05 (Pty)"],
    ["209801234505"], ["２０９８／１２３４５／０５"], ["2098​12345​05"],
  ])("%s is the one registration number 2098/012345/05", (written) => {
    expect(canonicalIdentifier(written)).toBe("20980123455")
    expect(flagged(written, "2098/012345/05")).toBe(true)
    expect(flagged("2098/12345/05", written)).toBe(true)
  })

  it("keeps different registration numbers apart", () => {
    expect(flagged("2098/12345/07", "2098/012345/05")).toBe(false) // another suffix
    expect(flagged("2098/12345", "2098/012345/05")).toBe(false) // no suffix
    expect(flagged("2099/12345/05", "2098/012345/05")).toBe(false) // another year
    expect(flagged("2098/123456/05", "2098/12345/05")).toBe(false) // another number
  })

  it("reads a digit run and an odd split of twelve digits as year, number and suffix", () => {
    expect(canonicalIdentifier("209812345605")).toBe("20981234565")
    expect(canonicalIdentifier("20981234 5605")).toBe("20981234565")
    expect(canonicalIdentifier("2098 123456 05")).toBe("20981234565")
    expect(canonicalIdentifier("2098/1234567/05")).toBe("2098123456705")
  })

  it("finds a registration number with unpadded segments in free text", () => {
    const coi: ScreeningCandidates = { kind: "COI_DECLARATION", names: [], identifiers: [], freeText: ["Director of Zed Hauliers, company 2098 / 12345 / 5"] }
    expect(screenBuyer({ name: "Zzyzx Stranger", identifier: "2098/012345/05" }, [coi]).match).toBe(true)
    expect(screenBuyer({ name: "Zzyzx Stranger", identifier: "2098/012345/07" }, [coi]).match).toBe(false)
  })
})
