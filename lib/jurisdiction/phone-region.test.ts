import { describe, expect, it } from "vitest"
import { isValidKenyaMobile, isValidLesothoMobile, trunkZeroDialCode } from "./phone-region"
import { LESOTHO_DISTRICTS } from "./profiles"

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
    expect(LESOTHO_DISTRICTS.map((d) => d.code)).toContain("MS")
  })
})

describe("Kenyan mobile", () => {
  it("accepts +254 and local 07…/010…/011… mobiles, spaces allowed", () => {
    expect(isValidKenyaMobile("+254712345678")).toBe(true)
    expect(isValidKenyaMobile("+254 712 345 678")).toBe(true)
    expect(isValidKenyaMobile("0712345678")).toBe(true)
    expect(isValidKenyaMobile("0110123456")).toBe(true)
  })

  it("refuses landlines, other countries and the wrong length", () => {
    expect(isValidKenyaMobile("0201234567")).toBe(false)
    expect(isValidKenyaMobile("+27821234567")).toBe(false)
    expect(isValidKenyaMobile("+26658123456")).toBe(false)
    expect(isValidKenyaMobile("071234567")).toBe(false)
  })
})

describe("the country code of a local number written with a trunk 0", () => {
  it("is the lender's own; Lesotho has no trunk prefix, so there it stays South African", () => {
    expect(trunkZeroDialCode("ZA")).toBe("27")
    expect(trunkZeroDialCode("KE")).toBe("254")
    expect(trunkZeroDialCode("LS")).toBe("27")
  })
})
