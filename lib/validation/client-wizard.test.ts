import { afterEach, describe, expect, it, vi } from "vitest"
import { BankAccountType, EmploymentStatus, IncomeSourceType } from "@prisma/client"
import {
  ACCOUNT_TYPES,
  EMPLOYMENT_STATUSES,
  INCOME_SOURCE_TYPES,
  UNEMPLOYED_STATUSES,
  earliestStepWithErrors,
  isValidSaIdNumber,
  deriveDobFromSaId,
  deriveGenderFromSaId,
  isValidSaPhone,
  validateStep1Identity,
  validateStep2Address,
  validateStep3Employment,
  validateStep4Review,
  validateAllClient,
} from "./client-wizard"
import { EMPTY_CLIENT_WIZARD_DATA } from "@/components/clients/wizard/types"

// Sample valid SA ID — DOB 1990-01-01, male sequence, correct Luhn checksum.
// The original plan vector 9001015009087 fails Luhn (off-by-one on check digit);
// 9001015009086 is the correct passing form.
const VALID_SA_ID_MALE_1990 = "9001015009086"

describe("isValidSaIdNumber", () => {
  it("accepts a valid 13-digit SA ID with correct Luhn", () => {
    expect(isValidSaIdNumber(VALID_SA_ID_MALE_1990)).toBe(true)
  })

  it("rejects wrong length", () => {
    expect(isValidSaIdNumber("900101500908")).toBe(false)
    expect(isValidSaIdNumber("90010150090877")).toBe(false)
  })

  it("rejects non-digits", () => {
    expect(isValidSaIdNumber("9001015a09086")).toBe(false)
  })

  it("rejects bad Luhn", () => {
    expect(isValidSaIdNumber("9001015009088")).toBe(false)
  })

  it("rejects impossible DOB month", () => {
    expect(isValidSaIdNumber("9013015009086")).toBe(false)
  })

  it("rejects impossible DOB day", () => {
    expect(isValidSaIdNumber("9001325009086")).toBe(false)
  })
})

describe("deriveDobFromSaId", () => {
  it("returns ISO date for 1990-01-01", () => {
    expect(deriveDobFromSaId(VALID_SA_ID_MALE_1990)).toBe("1990-01-01")
  })

  it("returns ISO date for a 2005 birth year (digit '05')", () => {
    // 0501015800086 — 2005-01-01, male, correct Luhn
    // (plan vector 0501015800089 failed Luhn; 0501015800086 is the correct form)
    const id = "0501015800086"
    expect(deriveDobFromSaId(id)).toBe("2005-01-01")
  })

  it("returns empty string for invalid input", () => {
    expect(deriveDobFromSaId("bogus")).toBe("")
  })
})

describe("deriveGenderFromSaId", () => {
  it("returns FEMALE for sequence 0000 (lowest female)", () => {
    expect(deriveGenderFromSaId("9001010000086")).toBe("FEMALE")
  })

  it("returns FEMALE for sequence 4999 (highest female)", () => {
    expect(deriveGenderFromSaId("9001014999086")).toBe("FEMALE")
  })

  it("returns MALE for sequence 5000 (lowest male)", () => {
    expect(deriveGenderFromSaId("9001015000086")).toBe("MALE")
  })

  it("returns MALE for sequence 9999 (highest male)", () => {
    expect(deriveGenderFromSaId("9001019999086")).toBe("MALE")
  })

  it("returns empty string for IDs shorter than 13 digits", () => {
    expect(deriveGenderFromSaId("900101")).toBe("")
    expect(deriveGenderFromSaId("")).toBe("")
    expect(deriveGenderFromSaId("90010100000")).toBe("")
  })

  it("returns empty string for IDs longer than 13 digits", () => {
    expect(deriveGenderFromSaId("90010150000860000")).toBe("")
    expect(deriveGenderFromSaId("9001015000086X")).toBe("")
  })

  it("returns empty string for non-numeric sequence digits", () => {
    expect(deriveGenderFromSaId("900101abcd086")).toBe("")
  })
})

describe("isValidSaPhone", () => {
  it("accepts +27 format", () => {
    expect(isValidSaPhone("+27821234567")).toBe(true)
  })

  it("accepts 0... format", () => {
    expect(isValidSaPhone("0821234567")).toBe(true)
  })

  it("rejects landline-style 0 prefix outside mobile range", () => {
    expect(isValidSaPhone("0121234567")).toBe(false)
  })

  it("rejects shorter than 10 digits", () => {
    expect(isValidSaPhone("082123456")).toBe(false)
  })

  it("rejects non-digit garbage", () => {
    expect(isValidSaPhone("not-a-phone")).toBe(false)
  })
})

describe("validateStep1Identity", () => {
  const full = {
    ...EMPTY_CLIENT_WIZARD_DATA,
    firstName: "Sipho",
    lastName: "Mokoena",
    idNumber: VALID_SA_ID_MALE_1990,
    dateOfBirth: "1990-01-01",
    gender: "MALE" as const,
    email: "sipho@example.co.za",
    phone: "+27821234567",
    whatsapp: "+27821234567",
  }

  it("passes with all fields valid", () => {
    expect(validateStep1Identity(full)).toEqual({})
  })

  it("flags every empty required field", () => {
    const e = validateStep1Identity(EMPTY_CLIENT_WIZARD_DATA)
    expect(e.firstName).toBeDefined()
    expect(e.lastName).toBeDefined()
    expect(e.idNumber).toBeDefined()
    expect(e.dateOfBirth).toBeDefined()
    expect(e.gender).toBeDefined()
    expect(e.email).toBeDefined()
    expect(e.phone).toBeDefined()
    // whatsapp is optional — should not be flagged when empty
    expect(e.whatsapp).toBeUndefined()
  })

  it("flags malformed email", () => {
    const e = validateStep1Identity({ ...full, email: "not-an-email" })
    expect(e.email).toBeDefined()
  })

  it("flags malformed SA ID", () => {
    const e = validateStep1Identity({ ...full, idNumber: "12345" })
    expect(e.idNumber).toBeDefined()
  })

  it("flags malformed phone", () => {
    const e = validateStep1Identity({ ...full, phone: "abc" })
    expect(e.phone).toBeDefined()
  })

  it("flags DOB mismatch with ID number", () => {
    const e = validateStep1Identity({ ...full, dateOfBirth: "1991-06-15" })
    expect(e.dateOfBirth).toBeDefined()
  })
})

describe("deriveDobFromSaId — dynamic century cutoff", () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it("classifies a yy-equal-to-current-year ID as 20xx (newborn)", () => {
    // Freeze the clock to 2030-06-01; current 2-digit year = 30.
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2030-06-01T00:00:00Z"))
    // 3001015009082 — yy=30, mm=01, dd=01, Luhn-valid.
    expect(deriveDobFromSaId("3001015009082")).toBe("2030-01-01")
  })

  it("classifies a yy-greater-than-current-year ID as 19xx", () => {
    // Freeze the clock to 2030-06-01; yy=85 > 30, so 1985.
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2030-06-01T00:00:00Z"))
    // 8501015009086 — yy=85, mm=01, dd=01, Luhn-valid.
    expect(deriveDobFromSaId("8501015009086")).toBe("1985-01-01")
  })
})

describe("earliestStepWithErrors", () => {
  it("maps a step-1 field to step 1", () => {
    expect(earliestStepWithErrors({ firstName: "Required" })).toBe(1)
    expect(earliestStepWithErrors({ idNumber: "Bad" })).toBe(1)
    expect(earliestStepWithErrors({ whatsapp: "Bad" })).toBe(1)
  })

  it("returns 4 (review) when no field is mapped to a step", () => {
    // Empty map — should fall through to review so the user sees the
    // generic banner rather than being bounced to step 1.
    expect(earliestStepWithErrors({})).toBe(4)
  })

  it("returns the earliest step when multiple step-1 fields are flagged", () => {
    expect(
      earliestStepWithErrors({
        firstName: "Required",
        email: "Bad",
        phone: "Bad",
      }),
    ).toBe(1)
  })

  it("maps a step-2 field to step 2", () => {
    expect(earliestStepWithErrors({ suburb: "Required" })).toBe(2)
    expect(earliestStepWithErrors({ postalCode: "Bad" })).toBe(2)
  })

  it("maps a step-3 field to step 3", () => {
    expect(earliestStepWithErrors({ employmentStatus: "Required" })).toBe(3)
    expect(earliestStepWithErrors({ bankAccountNumber: "Required" })).toBe(3)
  })

  it("returns the earliest step when both step-2 and step-3 fields are flagged", () => {
    expect(
      earliestStepWithErrors({
        suburb: "Required",
        employmentStatus: "Required",
      }),
    ).toBe(2)
  })

  it("maps a nested expenseBreakdown error to step 3", () => {
    expect(
      earliestStepWithErrors({ expenseBreakdown: { housing: "Numeric amount in Rand" } }),
    ).toBe(3)
  })

  it("maps a nested debtObligations row error to step 3", () => {
    expect(
      earliestStepWithErrors({
        debtObligations: [
          {},
          { outstandingBalance: "Required", monthlyInstalment: "Required" },
        ],
      }),
    ).toBe(3)
  })

  it("ignores an empty expenseBreakdown / debtObligations entry", () => {
    // A breakdown object with no truthy values OR an array of empty row-error
    // objects must NOT rewind to step 3 — the user has nothing to fix there.
    expect(earliestStepWithErrors({ expenseBreakdown: {} })).toBe(4)
    expect(earliestStepWithErrors({ debtObligations: [{}, {}] })).toBe(4)
  })

  it("prefers step 1 when a step-1 field error coexists with a nested step-3 error", () => {
    expect(
      earliestStepWithErrors({
        firstName: "Required",
        expenseBreakdown: { housing: "x" },
      }),
    ).toBe(1)
  })
})

describe("validateStep2Address", () => {
  const full = {
    ...EMPTY_CLIENT_WIZARD_DATA,
    suburb: "Sandton",
    city: "Johannesburg",
    province: "GP",
    postalCode: "2196",
  }

  it("passes when complete", () => {
    expect(validateStep2Address(full)).toEqual({})
  })

  it("flags empty required fields", () => {
    const e = validateStep2Address(EMPTY_CLIENT_WIZARD_DATA)
    expect(e.suburb).toBeDefined()
    expect(e.city).toBeDefined()
    expect(e.province).toBeDefined()
    expect(e.postalCode).toBeDefined()
  })

  it("rejects province codes outside the SA set", () => {
    const e = validateStep2Address({ ...full, province: "ZZ" })
    expect(e.province).toBeDefined()
  })

  it("rejects postal codes that are not 4 digits", () => {
    expect(validateStep2Address({ ...full, postalCode: "abcd" }).postalCode).toBeDefined()
    expect(validateStep2Address({ ...full, postalCode: "21" }).postalCode).toBeDefined()
    expect(validateStep2Address({ ...full, postalCode: "21960" }).postalCode).toBeDefined()
  })
})

describe("validateStep3Employment", () => {
  const full = {
    ...EMPTY_CLIENT_WIZARD_DATA,
    employmentStatus: "EMPLOYED",
    incomeSourceType: "SALARY",
    employerName: "Acme",
    employerAddress: "1 Main Rd",
    employmentStartDate: "2020-01-01",
    salaryPaymentDay: "25",
    monthlyIncome: "15000",
    // Gross intentionally empty so the MLE gate doesn't fire on the baseline
    // `full` fixture (no breakdown, no MLE check). Tests that exercise the
    // MLE rule set `grossMonthlyIncome` explicitly.
    grossMonthlyIncome: "",
    monthlyExpenses: "",
    bankName: "FNB",
    bankAccountNumber: "62123456789",
    bankBranchCode: "250655",
    accountType: "CHEQUE",
    nextOfKinName: "Thandi Mokoena",
    nextOfKinPhone: "+27821112233",
    nextOfKinRelationship: "Spouse",
  }

  it("passes when complete", () => {
    expect(validateStep3Employment(full)).toEqual({})
  })

  it("flags empty employmentStatus + incomeSourceType", () => {
    const e = validateStep3Employment(EMPTY_CLIENT_WIZARD_DATA)
    expect(e.employmentStatus).toBeDefined()
    expect(e.incomeSourceType).toBeDefined()
    expect(e.monthlyIncome).toBeDefined()
    expect(e.bankAccountNumber).toBeDefined()
    expect(e.nextOfKinPhone).toBeDefined()
  })

  it("rejects non-numeric monthlyIncome", () => {
    const e = validateStep3Employment({ ...full, monthlyIncome: "lots" })
    expect(e.monthlyIncome).toBeDefined()
  })

  it("accepts an empty expense breakdown (all categories default to 0)", () => {
    const e = validateStep3Employment(full)
    expect(e.expenseBreakdown).toBeUndefined()
  })

  it("flags non-numeric values in any expense category", () => {
    const e = validateStep3Employment({
      ...full,
      expenseBreakdown: { ...full.expenseBreakdown, housing: "lots" },
    })
    expect(e.expenseBreakdown?.housing).toBeDefined()
  })

  it("requires belowMleJustification when sum < NCA Reg 23A minimum", () => {
    // R 8,000 gross → MLE floor R 1,286 (800 + 6.75% × 7,200). R 100 housing only.
    const e = validateStep3Employment({
      ...full,
      grossMonthlyIncome: "8000",
      expenseBreakdown: { ...full.expenseBreakdown, housing: "100" },
    })
    expect(e.expenseBreakdown?.belowMleJustification).toBeDefined()
  })

  it("clears the MLE error when justification is provided", () => {
    const e = validateStep3Employment({
      ...full,
      grossMonthlyIncome: "8000",
      expenseBreakdown: {
        ...full.expenseBreakdown,
        housing: "100",
        belowMleJustification: "Lives rent-free with family; verified",
      },
    })
    expect(e.expenseBreakdown?.belowMleJustification).toBeUndefined()
  })

  it("does not require justification when sum >= MLE", () => {
    // R 8,000 gross → MLE ~R 1,286. R 1,500 captured = above floor.
    const e = validateStep3Employment({
      ...full,
      grossMonthlyIncome: "8000",
      expenseBreakdown: { ...full.expenseBreakdown, housing: "1500" },
    })
    expect(e.expenseBreakdown?.belowMleJustification).toBeUndefined()
  })

  it("does not check MLE when grossMonthlyIncome is empty", () => {
    const e = validateStep3Employment({
      ...full,
      grossMonthlyIncome: "",
      expenseBreakdown: { ...full.expenseBreakdown, housing: "0" },
    })
    expect(e.expenseBreakdown).toBeUndefined()
  })

  it("accepts an empty debt-obligations array", () => {
    const e = validateStep3Employment({ ...full, debtObligations: [] })
    expect(e.debtObligations).toBeUndefined()
  })

  it("flags per-row missing fields when any of the three core fields is filled", () => {
    const e = validateStep3Employment({
      ...full,
      debtObligations: [
        { rowKey: "r1", creditProvider: "FNB Card", accountType: "CREDIT_CARD", outstandingBalance: "", monthlyInstalment: "", notes: "" },
      ],
    })
    expect(e.debtObligations?.[0]?.outstandingBalance).toBeDefined()
    expect(e.debtObligations?.[0]?.monthlyInstalment).toBeDefined()
  })

  it("accepts a fully-empty debt row (skipped, not validated)", () => {
    const e = validateStep3Employment({
      ...full,
      debtObligations: [
        { rowKey: "r2", creditProvider: "", accountType: "OTHER", outstandingBalance: "", monthlyInstalment: "", notes: "" },
      ],
    })
    expect(e.debtObligations).toBeUndefined()
  })

  it("accepts a fully-filled debt row", () => {
    const e = validateStep3Employment({
      ...full,
      debtObligations: [
        { rowKey: "r3", creditProvider: "FNB Card", accountType: "CREDIT_CARD", outstandingBalance: "5000", monthlyInstalment: "500", notes: "Visa" },
      ],
    })
    expect(e.debtObligations).toBeUndefined()
  })

  it("rejects salary payment day outside 1-31", () => {
    expect(validateStep3Employment({ ...full, salaryPaymentDay: "0" }).salaryPaymentDay).toBeDefined()
    expect(validateStep3Employment({ ...full, salaryPaymentDay: "32" }).salaryPaymentDay).toBeDefined()
  })

  it("flags malformed next-of-kin phone", () => {
    const e = validateStep3Employment({ ...full, nextOfKinPhone: "nope" })
    expect(e.nextOfKinPhone).toBeDefined()
  })

  it("does not require employer fields when status is UNEMPLOYED", () => {
    const e = validateStep3Employment({
      ...full,
      employmentStatus: "UNEMPLOYED",
      employerName: "",
      employerAddress: "",
      employmentStartDate: "",
    })
    expect(e.employerName).toBeUndefined()
    expect(e.employerAddress).toBeUndefined()
    expect(e.employmentStartDate).toBeUndefined()
  })

  it("does not require salaryPaymentDay when status is UNEMPLOYED", () => {
    const e = validateStep3Employment({
      ...full,
      employmentStatus: "UNEMPLOYED",
      employerName: "",
      employerAddress: "",
      employmentStartDate: "",
      salaryPaymentDay: "",
    })
    expect(e.salaryPaymentDay).toBeUndefined()
  })
})

describe("validateStep4Review", () => {
  it("flags missing popiaConsentGiven", () => {
    const e = validateStep4Review({ ...EMPTY_CLIENT_WIZARD_DATA, popiaConsentGiven: false })
    expect(e.popiaConsentGiven).toBeDefined()
  })

  it("passes when consent given", () => {
    const e = validateStep4Review({ ...EMPTY_CLIENT_WIZARD_DATA, popiaConsentGiven: true })
    expect(e.popiaConsentGiven).toBeUndefined()
  })
})

// Regression guard for the 2026-07-28 production incident: the Step 3
// dropdowns offered values ("WAGES", "BUSINESS", "GRANT", "PART_TIME",
// "STUDENT", "RETIRED", "TRANSMISSION") that were not members of the Prisma
// enum they are persisted to. Selecting one reached prisma.client.create()
// and threw PrismaClientValidationError, so "Create client" failed.
//
// The two sides compared here are genuinely independent sources: the option
// list is hand-written UI data, the enum is generated from schema.prisma.
describe("Step 3 dropdown values are members of their Prisma enum", () => {
  const cases: { name: string; options: { value: string }[]; enumValues: string[] }[] = [
    { name: "employmentStatus", options: EMPLOYMENT_STATUSES, enumValues: Object.keys(EmploymentStatus) },
    { name: "incomeSourceType", options: INCOME_SOURCE_TYPES, enumValues: Object.keys(IncomeSourceType) },
    { name: "accountType", options: ACCOUNT_TYPES, enumValues: Object.keys(BankAccountType) },
  ]

  for (const { name, options, enumValues } of cases) {
    it(`every ${name} option is a valid enum member`, () => {
      const offered = options.map((o) => o.value)
      expect(offered.filter((v) => !enumValues.includes(v))).toEqual([])
    })
  }

  it("UNEMPLOYED_STATUSES only names real EmploymentStatus members", () => {
    const enumValues = Object.keys(EmploymentStatus)
    expect([...UNEMPLOYED_STATUSES].filter((v) => !enumValues.includes(v))).toEqual([])
  })
})

describe("validateAllClient", () => {
  it("returns the union of all four step error maps", () => {
    const e = validateAllClient(EMPTY_CLIENT_WIZARD_DATA)
    // step 1
    expect(e.firstName).toBeDefined()
    // step 2
    expect(e.suburb).toBeDefined()
    // step 3
    expect(e.employmentStatus).toBeDefined()
    // step 4
    expect(e.popiaConsentGiven).toBeDefined()
  })
})
