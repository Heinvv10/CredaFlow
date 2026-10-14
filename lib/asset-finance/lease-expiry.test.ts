import { describe, expect, it } from "vitest"
import { businessDaysBefore, expiryNoticeDue } from "./lease-expiry"

describe("CPA s14 expiry notice window (C7)", () => {
  it("counts South African business days from today up to the expiry date", () => {
    expect(businessDaysBefore("2027-03-01", "2027-03-08")).toBe(5) // Tue–Fri + Mon
    expect(businessDaysBefore("2027-12-15", "2027-12-20")).toBe(2) // 16 Dec is a holiday; 17, 20
  })
  it("is due from 80 down to 40 business days before expiry, for a CPA lessee only", () => {
    const expiry = "2028-06-30"
    // Walk back from expiry to the latest day with 81 business days to go, and the first with 80.
    let day = new Date(`${expiry}T00:00:00Z`)
    const iso = () => day.toISOString().slice(0, 10)
    while (businessDaysBefore(iso(), expiry) < 81) day = new Date(day.getTime() - 86_400_000)
    const day81 = iso()
    day = new Date(day.getTime() + 86_400_000)
    while (businessDaysBefore(iso(), expiry) !== 80) day = new Date(day.getTime() + 86_400_000)
    const day80 = iso()
    expect(expiryNoticeDue({ today: day80, expiryDate: expiry, cpaApplies: true })).toBe(true)
    expect(expiryNoticeDue({ today: day81, expiryDate: expiry, cpaApplies: true })).toBe(false)
    expect(expiryNoticeDue({ today: day80, expiryDate: expiry, cpaApplies: false })).toBe(false)
    expect(expiryNoticeDue({ today: "2028-06-29", expiryDate: expiry, cpaApplies: true })).toBe(false) // 1: too late
  })
})
