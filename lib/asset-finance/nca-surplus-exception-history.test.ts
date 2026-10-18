import { describe, expect, it } from "vitest"
import { issuedHeldSurplusException } from "./nca-surplus-exception-history"
const release = new Date("2026-10-18T10:00:00Z")
const row = { exceptionReason: "TEST missing account during preparation", releasedAt: release }
describe("prepared held surplus versus an actually issued exception", () => {
  it("does not invent an original held statement when preparation released before first final notice", () => {
    expect(issuedHeldSurplusException(row, null)).toBe(false)
    expect(issuedHeldSurplusException(row, { createdAt: new Date("2026-10-18T11:00:00Z"), newValue: { surplusDisposition: "INSTRUCTED" } })).toBe(false)
  })
  it("retains an actual issued held statement after later release", () => {
    expect(issuedHeldSurplusException(row, { createdAt: release, newValue: { surplusDisposition: "HELD_NO_VERIFIED_ACCOUNT" } })).toBe(true)
    expect(issuedHeldSurplusException(row, { createdAt: new Date("2026-10-18T09:00:00Z"), newValue: {} })).toBe(true)
  })
})
