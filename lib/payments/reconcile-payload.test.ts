import { describe, expect, it } from "vitest"
import { reconcileBody, requiresOverride } from "./reconcile-payload"

const BASE = {
  action: "allocate" as const,
  reason: "Matched bank settlement",
  reference: "BANK-REF-123",
  valueDateOverrideReason: "",
}

describe("reconcileBody", () => {
  it("omits the override when none was given", () => {
    expect(reconcileBody(BASE)).toEqual({
      action: "allocate",
      reason: "Matched bank settlement",
      reference: "BANK-REF-123",
    })
  })

  it("sends the override so a refused receipt can be released", () => {
    // Without this the server keeps returning 422 and the money is stuck —
    // the reconcile screen is the only place unapplied money is discharged.
    expect(reconcileBody({
      ...BASE,
      valueDateOverrideReason: "  Branch cash banked 14 July, found in the safe  ",
    })).toEqual({
      action: "allocate",
      reason: "Matched bank settlement",
      reference: "BANK-REF-123",
      valueDateOverrideReason: "Branch cash banked 14 July, found in the safe",
    })
  })

  it("treats a whitespace-only override as none", () => {
    expect(reconcileBody({ ...BASE, valueDateOverrideReason: "   \n " }))
      .not.toHaveProperty("valueDateOverrideReason")
  })

  it("withholds the override from a refund, which rebates nothing", () => {
    expect(reconcileBody({
      ...BASE,
      action: "record_refund",
      valueDateOverrideReason: "Branch cash banked 14 July, found in the safe",
    })).not.toHaveProperty("valueDateOverrideReason")
  })
})

describe("requiresOverride", () => {
  it("opens the override field when the server asks for one", () => {
    expect(requiresOverride({ requiresValueDateOverride: true })).toBe(true)
  })

  it("stays closed for an ordinary refusal", () => {
    // e.g. an over-settlement 422, which no reason can clear.
    expect(requiresOverride({})).toBe(false)
    expect(requiresOverride({ requiresValueDateOverride: false })).toBe(false)
  })
})
