import { describe, expect, it } from "vitest"
import { isValidLesothoNationalId, LESOTHO_ID_SHAPE_ONLY } from "./national-id"

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
