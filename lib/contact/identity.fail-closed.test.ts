import { afterEach, describe, expect, it } from "vitest"
import { resetActiveJurisdiction, setActiveJurisdiction } from "@/lib/jurisdiction/active"
import { normalisePhone, toWaJid } from "./identity"

afterEach(() => resetActiveJurisdiction())

// A local "0…" number means a different country per lender (27 or 254). Until the
// jurisdiction is loaded the code does not know which, so it records no identity
// rather than guess South Africa and send a Kenyan borrower's message to an SA number.
describe("a local 0 number while no jurisdiction is loaded", () => {
  it("is refused: no identity", () => {
    expect(normalisePhone("0712345678")).toBe("")
    expect(normalisePhone("0821234567")).toBe("")
    expect(toWaJid("0712345678")).toBe("")
  })

  it("is taken when the caller names the jurisdiction", () => {
    expect(normalisePhone("0821234567", "ZA")).toBe("27821234567")
    expect(normalisePhone("0712345678", "KE")).toBe("254712345678")
    expect(toWaJid("0821234567", "ZA")).toBe("27821234567@s.whatsapp.net")
  })

  it("international numbers need no jurisdiction and are unchanged", () => {
    expect(normalisePhone("+27821234567")).toBe("27821234567")
    expect(normalisePhone("0027821234567")).toBe("27821234567")
    expect(normalisePhone("+254712345678")).toBe("254712345678")
    expect(normalisePhone("+26658000001")).toBe("26658000001")
  })
})

describe("once loaded", () => {
  it("ZA is unchanged", () => {
    setActiveJurisdiction({ jurisdiction: "ZA", currency: "ZAR" })
    expect(normalisePhone("0821234567")).toBe("27821234567")
    expect(normalisePhone(" 082 123 4567 ")).toBe("27821234567")
    expect(toWaJid("0821234567")).toBe("27821234567@s.whatsapp.net")
  })

  it("KE takes 254", () => {
    setActiveJurisdiction({ jurisdiction: "KE", currency: "KES" })
    expect(normalisePhone("0712345678")).toBe("254712345678")
  })
})
