import { describe, expect, it } from "vitest"
import { LESOTHO_DISTRICTS, isValidLesothoMobile } from "./phone-region"

describe("Lesotho phone and district", () => {
  it("accepts +266 and local 8-digit mobiles starting 5 or 6", () => {
    expect(isValidLesothoMobile("+26658123456")).toBe(true)
    expect(isValidLesothoMobile("+26662123456")).toBe(true)
    expect(isValidLesothoMobile("58123456")).toBe(true)
  })

  it("refuses South African, landline and malformed numbers", () => {
    expect(isValidLesothoMobile("+27821234567")).toBe(false)
    expect(isValidLesothoMobile("22123456")).toBe(false)
    expect(isValidLesothoMobile("+2665812345")).toBe(false)
    expect(isValidLesothoMobile("")).toBe(false)
  })

  it("lists the ten districts", () => {
    expect(LESOTHO_DISTRICTS).toHaveLength(10)
    expect(LESOTHO_DISTRICTS).toContain("MS")
  })
})
