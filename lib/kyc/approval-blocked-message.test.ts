import { describe, expect, it } from "vitest"
import { kycApprovalBlockedMessage } from "./approval-blocked-message"

describe("kycApprovalBlockedMessage", () => {
  // Fair Score audit 2026-10-16: a 3-line wall of jargon ("exact reasoned
  // senior exception…"); the credit officer saw no way forward.
  it("says in plain words who can verify in person, and where", () => {
    const message = kycApprovalBlockedMessage({ enabled: true, minRole: "ADMIN" })
    expect(message).toContain("an Admin can verify the client in person")
    expect(message).toContain("on this client's KYC tab")
    expect(message).not.toMatch(/exact reasoned senior exception|composite|biometric attempt/)
  })

  it("names the lender's own minimum role", () => {
    expect(kycApprovalBlockedMessage({ enabled: true, minRole: "BRANCH_MANAGER" })).toContain("a Branch Manager or Admin can verify the client in person")
  })

  it("offers no alternative when the lender turned overrides off", () => {
    const message = kycApprovalBlockedMessage({ enabled: false, minRole: "ADMIN" })
    expect(message).toContain("Ask the client for a new selfie.")
    expect(message).not.toContain("in person")
  })
})
