import { describe, expect, it } from "vitest"
import { canonicalKenyaNationalId, isValidKenyaNationalId, isValidLesothoNationalId, KENYA_ID_SHAPE_ONLY, LESOTHO_ID_SHAPE_ONLY } from "./national-id"

describe("Lesotho national ID", () => {
  it("is shape-only: no checksum or date of birth is encoded in it (unconfirmed, see national-id.ts)", () => {
    expect(LESOTHO_ID_SHAPE_ONLY).toBe(true)
  })

  it("accepts a plausible alphanumeric ID, ignoring case and surrounding space", () => {
    expect(isValidLesothoNationalId("123456789")).toBe(true)
    expect(isValidLesothoNationalId(" 1234567890123 ")).toBe(true)
    expect(isValidLesothoNationalId("a1234567")).toBe(true)
  })

  it("refuses empty, short, long and punctuated values", () => {
    expect(isValidLesothoNationalId("")).toBe(false)
    expect(isValidLesothoNationalId("12345")).toBe(false)
    expect(isValidLesothoNationalId("1234567890123456")).toBe(false)
    expect(isValidLesothoNationalId("1234-5678")).toBe(false)
    expect(isValidLesothoNationalId("12345 678")).toBe(false)
  })
})

describe("Kenyan national ID", () => {
  it("is shape-only (unverified, see national-id.ts)", () => {
    expect(KENYA_ID_SHAPE_ONLY).toBe(true)
  })

  it("accepts an 8-digit national ID and a 9-digit Maisha Namba, ignoring spaces", () => {
    expect(isValidKenyaNationalId("12345678")).toBe(true)
    expect(isValidKenyaNationalId("123456789")).toBe(true)
    expect(isValidKenyaNationalId(" 1234 5678 ")).toBe(true)
    expect(canonicalKenyaNationalId(" 1234 5678 ")).toBe("12345678")
  })

  it("refuses 7 digits, letters, a 13-digit SA ID and punctuation", () => {
    expect(isValidKenyaNationalId("1234567")).toBe(false)
    expect(isValidKenyaNationalId("A1234567")).toBe(false)
    expect(isValidKenyaNationalId("9001015009086")).toBe(false)
    expect(isValidKenyaNationalId("1234-5678")).toBe(false)
    expect(isValidKenyaNationalId("")).toBe(false)
  })
})
