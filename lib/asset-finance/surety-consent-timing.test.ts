import { describe, expect, it } from "vitest"
import { consentTimingProblem, parseSuretyConsent } from "./surety-consent"

describe("MPA section 15(2)(h): consent precedes the suretyship", () => {
  const signedAt = new Date("2026-10-01T22:30:00Z") // 2 October in South Africa
  it("rejects ratification after signing, even with fresh staff verification", () => {
    expect(consentTimingProblem("2026-10-03", true, signedAt, "2026-10-17")).toMatch(/before.*surety/i)
  })
  it("allows late recording of consent actually obtained before signing", () => {
    expect(consentTimingProblem("2026-10-01", true, signedAt, "2026-10-17")).toBeNull()
  })
  it("requires same-day attestation and uses the South African signing date", () => {
    expect(consentTimingProblem("2026-10-02", true, signedAt, "2026-10-17")).toBeNull()
    expect(consentTimingProblem("2026-10-02", false, signedAt, "2026-10-17")).toMatch(/confirm/i)
  })
  it("rejects malformed optional timing even before evidence arrives", () => {
    expect(parseSuretyConsent({ maritalRegime: "UNMARRIED", suretySignedOn: "invalid" })).toBeTypeOf("string")
    expect(parseSuretyConsent({ maritalRegime: "IN_COMMUNITY", consentSignedOn: "2026-02-30" })).toBeTypeOf("string")
  })
  it("rejects missing, impossible and future consent dates", () => {
    for (const date of [null, "2026-02-30", "2026-10-18"]) expect(consentTimingProblem(date, true, null, "2026-10-17")).toBeTypeOf("string")
  })
})
