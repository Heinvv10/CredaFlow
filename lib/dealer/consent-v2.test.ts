import { describe, expect, it } from "vitest"
import { DEALER_CONSENT_STATEMENT, DEALER_CONSENT_VERSION, dealerConsentSnapshot, parseSigningMethod } from "./consent"

// dealer-consent-v2 (SLICE5-FOLLOWUPS.md part D): true for a form signed in
// front of the dealer and for one signed remotely; the snapshot adds how.
describe("dealer consent v2", () => {
  it("is v2 and says nothing of where the person was", () => {
    expect(DEALER_CONSENT_VERSION).toBe("dealer-consent-v2")
    expect(DEALER_CONSENT_STATEMENT).not.toMatch(/presence|in front of/i)
  })

  it("snapshots the statement and a line for the method", () => {
    expect(dealerConsentSnapshot("IN_PERSON", null)).toBe(`${DEALER_CONSENT_STATEMENT}\nSigned in person: I checked their identity document against them.`)
    expect(dealerConsentSnapshot("REMOTE", "Video call with the ID document")).toBe(
      `${DEALER_CONSENT_STATEMENT}\nSigned remotely. How I checked their identity: Video call with the ID document`)
  })

  it("needs a method; REMOTE needs the identity check (trimmed, 10 to 500), IN_PERSON none", () => {
    expect(parseSigningMethod({})).toBe("Say how the consent form was signed: in person or remotely")
    expect(parseSigningMethod({ signingMethod: "PHONE" })).toBe("Say how the consent form was signed: in person or remotely")
    expect(parseSigningMethod({ signingMethod: "IN_PERSON" })).toEqual({ signingMethod: "IN_PERSON", remoteIdentityCheck: null })
    expect(parseSigningMethod({ signingMethod: "IN_PERSON", remoteIdentityCheck: "Video call" })).toMatch(/only for a form signed remotely/)
    expect(parseSigningMethod({ signingMethod: "REMOTE" })).toMatch(/10 to 500 characters/)
    expect(parseSigningMethod({ signingMethod: "REMOTE", remoteIdentityCheck: "  123456789  " })).toMatch(/10 to 500 characters/)
    expect(parseSigningMethod({ signingMethod: "REMOTE", remoteIdentityCheck: "x".repeat(501) })).toMatch(/10 to 500 characters/)
    expect(parseSigningMethod({ signingMethod: "REMOTE", remoteIdentityCheck: "  1234567890  " })).toEqual({ signingMethod: "REMOTE", remoteIdentityCheck: "1234567890" })
  })
})
