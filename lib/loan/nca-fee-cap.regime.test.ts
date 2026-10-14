import { describe, expect, it } from "vitest"
import { capInitiationFee, ncaInitiationFeeCap } from "./nca-fee-cap"

// Reg 42 binds NCA credit agreements only (asset finance slice 1, item 4.2).

describe("capInitiationFee by NCA regime", () => {
  const principal = 300_000 // R3,000: the cap is ~R419.75, below a R450 fee
  const configured = 45_000

  it("caps an NCA agreement, and an agreement whose regime is not given", () => {
    expect(ncaInitiationFeeCap(principal)).toBeLessThan(configured)
    expect(capInitiationFee(configured, principal, "MICRO", "NCA")).toBe(ncaInitiationFeeCap(principal))
    expect(capInitiationFee(configured, principal, "MICRO")).toBe(ncaInitiationFeeCap(principal))
  })

  it("leaves a NON_NCA agreement's configured fee alone, whatever the product type", () => {
    expect(capInitiationFee(configured, principal, "MICRO", "NON_NCA")).toBe(configured)
    expect(capInitiationFee(configured, principal, null, "NON_NCA")).toBe(configured)
  })
})
