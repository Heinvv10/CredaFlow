import { afterEach, describe, expect, it } from "vitest"
import { resetActiveJurisdiction, setActiveJurisdiction } from "@/lib/jurisdiction/active"
import { normalisePhone, toWaJid } from "./identity"

afterEach(() => resetActiveJurisdiction())

describe("a Kenyan mobile number", () => {
  it("is an identity in its international form, under any lender", () => {
    expect(normalisePhone("+254712345678")).toBe("254712345678")
    expect(normalisePhone("+254 110 123 456")).toBe("254110123456")
    expect(toWaJid("+254712345678")).toBe("254712345678@s.whatsapp.net")
  })

  it("written locally with a 0, takes the Kenyan code under a Kenyan lender", () => {
    setActiveJurisdiction({ jurisdiction: "KE", currency: "KES" })
    expect(normalisePhone("0712345678")).toBe("254712345678")
    expect(normalisePhone("071 234 5678")).toBe("254712345678")
    expect(toWaJid("0712345678")).toBe("254712345678@s.whatsapp.net")
    // A Kenyan landline is not a mobile identity.
    expect(normalisePhone("0201234567")).toBe("")
  })

  it("leaves South African and Lesotho lenders exactly as they were", () => {
    expect(normalisePhone("0821234567")).toBe("27821234567")
    expect(normalisePhone("0712345678")).toBe("27712345678")
    expect(normalisePhone("0027821234567")).toBe("27821234567")
    setActiveJurisdiction({ jurisdiction: "LS", currency: "LSL" })
    expect(normalisePhone("0821234567")).toBe("27821234567")
    expect(normalisePhone("+26658000001")).toBe("26658000001")
  })

  it("does not widen anything else: a Kenyan landline and the wrong length stay out", () => {
    expect(normalisePhone("+254201234567")).toBe("")
    expect(normalisePhone("+25471234567")).toBe("")
  })
})
