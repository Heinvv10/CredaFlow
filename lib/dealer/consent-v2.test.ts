import { describe, expect, it } from "vitest"
import { DEALER_CONSENT_STATEMENT, DEALER_CONSENT_VERSION, dealerConsentSnapshot, parseSigningMethod } from "./consent"

// dealer-consent-v2 (SLICE5-FOLLOWUPS.md part D): true for a form signed in
// front of the dealer and for one signed remotely; the snapshot adds how.
describe("dealer consent v2", () => {
  it("is v2 and says nothing of where the person was: only the in-person line does", () => {
    expect(DEALER_CONSENT_VERSION).toBe("dealer-consent-v2")
    expect(DEALER_CONSENT_STATEMENT).not.toMatch(/presence|in front of/i)
    expect(dealerConsentSnapshot("REMOTE", "Video call with the ID document")).not.toMatch(/presence/i)
  })

  it("snapshots the statement and a line for the method", () => {
    expect(dealerConsentSnapshot("IN_PERSON", null)).toBe(`${DEALER_CONSENT_STATEMENT}\nSigned in my presence: I checked their identity document against them.`)
    expect(dealerConsentSnapshot("REMOTE", "Video call with the ID document")).toBe(
      `${DEALER_CONSENT_STATEMENT}\nSigned remotely. How their identity was checked: Video call with the ID document`)
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
    // Code points, as the database counts: five emoji are five characters.
    expect(parseSigningMethod({ signingMethod: "REMOTE", remoteIdentityCheck: "😀".repeat(5) })).toMatch(/10 to 500 characters/)
    expect(parseSigningMethod({ signingMethod: "REMOTE", remoteIdentityCheck: "😀".repeat(500) })).toMatchObject({ signingMethod: "REMOTE" })
  })
})
