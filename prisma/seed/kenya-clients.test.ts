import { afterEach, describe, expect, it } from "vitest"
import { normalisePhone } from "../../lib/contact/identity"
import { resetActiveJurisdiction, setActiveJurisdiction } from "../../lib/jurisdiction/active"
import { profileFor } from "../../lib/jurisdiction/profiles"
import { canonicalIdNumber, isValidIdNumber, isValidPhone } from "../../lib/validation/client-wizard"
import { CLIENTS_KE } from "./kenya-clients"
import { PRODUCTS_KE } from "./kenya-products"

afterEach(() => resetActiveJurisdiction())

describe("CLIENTS_KE, the Kenyan demo lender's borrowers", () => {
  it("are five obviously synthetic people: IDs 99000001 to 99000005", () => {
    expect(CLIENTS_KE.map((c) => c.idNumber)).toEqual(["99000001", "99000002", "99000003", "99000004", "99000005"])
    expect(new Set(CLIENTS_KE.map((c) => `${c.firstName}.${c.lastName}`)).size).toBe(5)
    for (const c of CLIENTS_KE) expect(c.bank).toBe("Demo Bank")
  })

  it.each(CLIENTS_KE.map((c) => [c.idNumber, c] as const))("%s passes the KE capture rules: ID, mobile, county, postcode", (_id, c) => {
    setActiveJurisdiction({ jurisdiction: "KE", currency: "KES" })
    const capture = profileFor("KE").capture
    expect(isValidIdNumber(c.idNumber)).toBe(true)
    expect(canonicalIdNumber(c.idNumber)).toBe(c.idNumber)
    expect(isValidPhone(c.phone)).toBe(true)
    expect(capture.regions.find((r) => r.code === c.prov)?.label).toBeTruthy()
    expect(c.postal).toMatch(new RegExp(`^\\d{${capture.postalDigits}}$`))
  })

  it("writes every mobile as +2547000000NN, so it has a 254 identity while the seed has no jurisdiction loaded", () => {
    resetActiveJurisdiction()
    for (const [i, c] of CLIENTS_KE.entries()) {
      expect(c.phone).toBe(`+2547000000${String(i + 1).padStart(2, "0")}`)
      expect(normalisePhone(c.phone)).toBe(c.phone.slice(1))
    }
  })
})

describe("PRODUCTS_KE", () => {
  it("is an M-Pesa 30-day loan of KES 1,000 to 50,000 and a personal loan of KES 10,000 to 500,000 (amounts in cents)", () => {
    expect(PRODUCTS_KE.map((p) => [p.code, p.minAmount, p.maxAmount, p.minTermDays, p.maxTermDays])).toEqual([
      ["MPESA30", 100_000, 5_000_000, 30, 30],
      ["PERSONAL", 1_000_000, 50_000_000, 90, 1_800],
    ])
  })
})
