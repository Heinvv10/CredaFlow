import { describe, expect, it } from "vitest"
import { normalisePhone, toWaJid } from "./identity"

describe("a Lesotho mobile number", () => {
  it("is an identity in its international form", () => {
    expect(normalisePhone("+26658000001")).toBe("26658000001")
    expect(normalisePhone("+266 6200 0002")).toBe("26662000002")
    expect(toWaJid("+26658000001")).toBe("26658000001@s.whatsapp.net")
  })

  it("does not widen anything else: a Lesotho landline, a short number and other foreign numbers stay out, and South African ones are as they were", () => {
    expect(normalisePhone("+26622000000")).toBe("")
    expect(normalisePhone("+2665800000")).toBe("")
    expect(normalisePhone("+14155550100")).toBe("")
    expect(normalisePhone("0821234567")).toBe("27821234567")
    expect(normalisePhone("+27821234567")).toBe("27821234567")
  })
})
