import { afterEach, describe, expect, it } from "vitest"
import { EMPTY_CLIENT_WIZARD_DATA } from "@/components/clients/wizard/types"
import { resetActiveJurisdiction, setActiveJurisdiction } from "@/lib/jurisdiction/active"
import {
  isValidIdNumber,
  isValidPhone,
  validateStep1Identity,
  validateStep2Address,
  validateStep3Employment,
} from "./client-wizard"

afterEach(() => resetActiveJurisdiction())
const asLesotho = () => setActiveJurisdiction({ jurisdiction: "LS", currency: "LSL" })

const base = { ...EMPTY_CLIENT_WIZARD_DATA, firstName: "Thabo", lastName: "Example", email: "t@example.test", gender: "MALE" as const }

describe("ZA capture is unchanged", () => {
  it("still demands a 13-digit SA ID and a +27 or 0 mobile", () => {
    expect(isValidIdNumber("9001015009086")).toBe(true)
    expect(isValidIdNumber("123456789")).toBe(false)
    expect(isValidPhone("0821234567")).toBe(true)
    expect(isValidPhone("+26658123456")).toBe(false)
    const errs = validateStep1Identity({ ...base, idNumber: "123456789", dateOfBirth: "1990-01-01", phone: "58123456" })
    expect(errs.idNumber).toBe("Not a valid 13-digit SA ID number")
    expect(errs.phone).toBe("Use +27… or 0… mobile format")
  })

  it("still demands an SA province and a 4-digit postcode", () => {
    const errs = validateStep2Address({ ...base, suburb: "x", city: "y", province: "MS", postalCode: "100" })
    expect(errs.province).toMatch(/SA province/)
    expect(errs.postalCode).toBe("Use a 4-digit SA postal code")
  })
})

describe("LS capture", () => {
  it("takes a Lesotho ID by shape and does not derive or cross-check date of birth", () => {
    asLesotho()
    expect(isValidIdNumber("123456789")).toBe(true)
    expect(isValidIdNumber("9001015009086")).toBe(true)
    expect(isValidIdNumber("12-34")).toBe(false)
    const errs = validateStep1Identity({ ...base, idNumber: "123456789", dateOfBirth: "1985-06-30", phone: "+26658123456", whatsapp: "62123456" })
    expect(errs).toEqual({})
  })

  it("refuses a South African mobile and a malformed ID with Lesotho wording", () => {
    asLesotho()
    const errs = validateStep1Identity({ ...base, idNumber: "12", dateOfBirth: "1985-06-30", phone: "0821234567" })
    expect(errs.idNumber).toBe("Not a valid Lesotho national ID number")
    expect(errs.phone).toBe("Use +266… or 8-digit mobile format")
  })

  it("takes a district code and a 3-digit postcode", () => {
    asLesotho()
    expect(validateStep2Address({ ...base, suburb: "x", city: "Maseru", province: "MS", postalCode: "100" })).toEqual({})
    const errs = validateStep2Address({ ...base, suburb: "x", city: "y", province: "GP", postalCode: "2000" })
    expect(errs.province).toMatch(/Lesotho district/)
    expect(errs.postalCode).toBe("Use a 3-digit Lesotho postal code")
  })

  it("checks the next of kin phone against Lesotho numbers", () => {
    asLesotho()
    const filled = {
      ...base, employmentStatus: "EMPLOYED", employerName: "Example Ltd", jobTitle: "Clerk", employmentStartDate: "2020-01-01",
      incomeSourceType: "SALARY", grossMonthlyIncome: "10000", netMonthlyIncome: "8000", bankName: "Example Bank",
      accountNumber: "12345678", accountType: "SAVINGS", branchCode: "123456", nextOfKinName: "Mpho", nextOfKinRelationship: "Sister",
    }
    const bad = validateStep3Employment({ ...filled, nextOfKinPhone: "0821234567" } as never)
    expect(bad.nextOfKinPhone).toBe("Use +266… or 8-digit mobile format")
    const good = validateStep3Employment({ ...filled, nextOfKinPhone: "+26662123456" } as never)
    expect(good.nextOfKinPhone).toBeUndefined()
  })
})
