import { describe, expect, it } from "vitest"
import { defaultTermInput, isFixedTerm, termIsInvalid, termForRequest, convertBlocked } from "./convert-term"

const variable = { minTermDays: 30, maxTermDays: 90 }
const fixed = { minTermDays: 30, maxTermDays: 30 }

describe("convert lead term", () => {
  it("starts empty for a variable product and uses the product term for a fixed one", () => {
    expect(defaultTermInput(variable)).toBe("")
    expect(defaultTermInput(fixed)).toBe("30")
  })

  it("detects fixed-term products", () => {
    expect(isFixedTerm(fixed)).toBe(true)
    expect(isFixedTerm(variable)).toBe(false)
  })

  it("flags empty, non-integer and out-of-range terms on a variable product", () => {
    for (const bad of ["", "abc", "45.5", "29", "91", "0", "-30"]) {
      expect(termIsInvalid(variable, bad), bad).toBe(true)
    }
    for (const ok of ["30", "45", "90"]) {
      expect(termIsInvalid(variable, ok), ok).toBe(false)
    }
  })

  it("never flags a fixed-term product, whatever the input", () => {
    expect(termIsInvalid(fixed, "")).toBe(false)
    expect(termIsInvalid(fixed, "999")).toBe(false)
  })

  it("sends the staff-entered term for a variable product, not maxTermDays", () => {
    expect(termForRequest(variable, "45")).toBe(45)
  })

  it("omits the term for a fixed-term product and when no product is selected", () => {
    expect(termForRequest(fixed, "30")).toBeUndefined()
    expect(termForRequest(undefined, "30")).toBeUndefined()
  })

  it("blocks conversion while loading or while a variable product has no valid term", () => {
    expect(convertBlocked(variable, "", false)).toBe(true)
    expect(convertBlocked(variable, "120", false)).toBe(true)
    expect(convertBlocked(variable, "45", false)).toBe(false)
    expect(convertBlocked(variable, "45", true)).toBe(true)
    expect(convertBlocked(fixed, "", false)).toBe(false)
    expect(convertBlocked(undefined, "", false)).toBe(false)
  })
})
