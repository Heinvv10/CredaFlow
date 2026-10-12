import { describe, it, expect } from "vitest"
import { effectiveApplyTermRange } from "@/lib/public-loan-products"
import { buildApplyMaterialPayload } from "./payload"

const base = {
  step1: { firstName: "Jane", email: "jane@example.test" },
  step2: { employmentStatus: "EMPLOYED" },
  attribution: { utmSource: "test" },
  popiaConsent: true,
}

describe("buildApplyMaterialPayload — term in the POST body", () => {
  it("catalogue-fixed product with a blank hidden field sends the fixed term", () => {
    const payload = buildApplyMaterialPayload({
      ...base,
      step3: { productType: "MICRO", amount: "1000", termDays: "", purpose: "x" },
      termRange: { min: 30, max: 30, fixed: true },
    })
    expect(payload.termDays).toBe("30")
  })

  it("catalogue-fixed product overrides a stale draft term", () => {
    const payload = buildApplyMaterialPayload({
      ...base,
      step3: { productType: "MICRO", amount: "1000", termDays: "7", purpose: "x" },
      termRange: { min: 30, max: 30, fixed: true },
    })
    expect(payload.termDays).toBe("30")
  })

  it("server-guided range turns a catalogue-fixed product into a typed-term payload", () => {
    const payload = buildApplyMaterialPayload({
      ...base,
      step3: { productType: "MICRO", amount: "1000", termDays: "75", purpose: "x" },
      termRange: effectiveApplyTermRange("MICRO", { min: 30, max: 30, fixed: true }, { productType: "MICRO", min: 60, max: 90 }),
    })
    expect(payload.termDays).toBe("75")
  })

  it("variable product sends the typed term, trimmed", () => {
    const payload = buildApplyMaterialPayload({
      ...base,
      step3: { productType: "PERSONAL", amount: "5000", termDays: " 180 ", purpose: "x" },
      termRange: { min: 90, max: 1800, fixed: false },
    })
    expect(payload.termDays).toBe("180")
  })

  it("keeps every other field, with consent and attribution", () => {
    const payload = buildApplyMaterialPayload({
      ...base,
      step3: { productType: "PERSONAL", amount: "5000", termDays: "90", purpose: "x" },
      termRange: undefined,
    })
    expect(payload).toMatchObject({
      firstName: "Jane",
      employmentStatus: "EMPLOYED",
      productType: "PERSONAL",
      amount: "5000",
      purpose: "x",
      utmSource: "test",
      popiaConsent: true,
    })
  })
})
