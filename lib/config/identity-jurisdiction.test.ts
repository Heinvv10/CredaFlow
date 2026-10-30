import { afterEach, describe, expect, it } from "vitest"
import { resetActiveJurisdiction, setActiveJurisdiction } from "@/lib/jurisdiction/active"
import {
  LenderIdentityError,
  parseLenderIdentity,
  parseNcrNumber,
  requireLenderIdentityFields,
  validateLenderIdentityColumns,
} from "./identity"
import { VALID_LENDER_COLUMNS } from "./__fixtures__/lender-identity"

afterEach(() => resetActiveJurisdiction())

// Obviously synthetic: a Maseru "Demo Road" office and 000 exchanges.
const LS_COLUMNS = {
  ...VALID_LENDER_COLUMNS,
  legalName: "Demo Basotho Lending (Pty) Ltd",
  brandName: "Demo Basotho Lending",
  ncrNumber: null,
  fscaNumber: null,
  companyRegNumber: "2099/000001",
  registeredOffice: "1 Demo Road\nMaseru\n100",
  publicPhone: "+266 2200 0000",
  collectionsPhone: "+266 2200 0001",
}

describe("ZA identity is unchanged", () => {
  it("refuses a Lesotho lender's identity", () => {
    expect(() => parseLenderIdentity(LS_COLUMNS)).toThrow(LenderIdentityError)
    const result = validateLenderIdentityColumns(LS_COLUMNS)
    expect(result.ok).toBe(false)
  })

  it("still requires an NCR number", () => {
    expect(() => parseNcrNumber(null)).toThrow(LenderIdentityError)
  })
})

describe("LS identity", () => {
  it("is valid with no NCR number, +266 phones and a free-form registration", () => {
    setActiveJurisdiction({ jurisdiction: "LS", currency: "LSL" })
    const identity = parseLenderIdentity(LS_COLUMNS)
    expect(identity).toMatchObject({
      ncrNumber: null,
      fspNumber: null,
      companyRegNumber: "2099/000001",
      publicPhoneE164: "+26622000000",
    })
    expect(validateLenderIdentityColumns(LS_COLUMNS).ok).toBe(true)
  })

  it("refuses a South African phone number", () => {
    setActiveJurisdiction({ jurisdiction: "LS", currency: "LSL" })
    expect(() => parseLenderIdentity({ ...LS_COLUMNS, publicPhone: "+27 11 000 0000" })).toThrow(LenderIdentityError)
  })

  it("never hands an NCA document an absent NCR number", () => {
    setActiveJurisdiction({ jurisdiction: "LS", currency: "LSL" })
    const identity = parseLenderIdentity(LS_COLUMNS)
    expect(() => requireLenderIdentityFields(identity, ["legalName", "ncrNumber"])).toThrow(LenderIdentityError)
    expect(requireLenderIdentityFields(identity, ["legalName"])).toEqual({ legalName: "Demo Basotho Lending (Pty) Ltd" })
  })

  it("an NCR number in the column is accepted when the lender has one to show", () => {
    setActiveJurisdiction({ jurisdiction: "LS", currency: "LSL" })
    expect(parseLenderIdentity({ ...LS_COLUMNS, ncrNumber: "CBL-LIC-0001" }).ncrNumber).toBe("CBL-LIC-0001")
  })
})
