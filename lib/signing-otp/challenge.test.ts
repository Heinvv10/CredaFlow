import { describe, expect, it } from "vitest"
import { consumeBlockedReason, verifyBlockedReason, type SigningBinding } from "./challenge"
import { signingOtpRequired } from "./policy"

const now = new Date("2026-10-14T10:00:00.000Z")
const minutes = (m: number) => new Date(now.getTime() + m * 60_000)
const fresh = {
  attempts: 0, maxAttempts: 5, expiresAt: minutes(5), verifiedAt: null, consumedAt: null, deliveryStatus: "ACCEPTED",
}

describe("verifyBlockedReason", () => {
  it("lets a fresh, delivered code be tried", () => {
    expect(verifyBlockedReason(fresh, now)).toBeNull()
  })

  it("expires at expiresAt exactly", () => {
    expect(verifyBlockedReason({ ...fresh, expiresAt: new Date(now.getTime() + 1) }, now)).toBeNull()
    expect(verifyBlockedReason({ ...fresh, expiresAt: now }, now)).toBe("expired")
  })

  it("locks once the attempts are spent", () => {
    expect(verifyBlockedReason({ ...fresh, attempts: 4 }, now)).toBeNull()
    expect(verifyBlockedReason({ ...fresh, attempts: 5 }, now)).toBe("locked")
  })

  it("never accepts a code that was used, or one that never left", () => {
    expect(verifyBlockedReason({ ...fresh, consumedAt: now }, now)).toBe("already_used")
    expect(verifyBlockedReason({ ...fresh, deliveryStatus: "FAILED" }, now)).toBe("delivery_failed")
    expect(verifyBlockedReason({ ...fresh, deliveryStatus: "PENDING" }, now)).toBe("delivery_failed")
  })
})

describe("consumeBlockedReason", () => {
  const binding: SigningBinding = {
    tenantId: "t1", clientId: "c1", purpose: "AGREEMENT", subjectId: "app-1", documentSha256: "a".repeat(64),
  }
  const verified = { ...fresh, ...binding, attempts: 1, verifiedAt: minutes(-1) }

  it("accepts a verified code for exactly this client, subject and bytes", () => {
    expect(consumeBlockedReason(verified, binding, now)).toBeNull()
  })

  it("refuses a code for other bytes of the same document", () => {
    expect(consumeBlockedReason(verified, { ...binding, documentSha256: "b".repeat(64) }, now)).toBe("document_changed")
  })

  it("refuses a code for another client, subject, purpose or tenant", () => {
    expect(consumeBlockedReason(verified, { ...binding, clientId: "c2" }, now)).toBe("not_found")
    expect(consumeBlockedReason(verified, { ...binding, subjectId: "app-2" }, now)).toBe("not_found")
    expect(consumeBlockedReason(verified, { ...binding, purpose: "DEBIT_MANDATE" }, now)).toBe("not_found")
    expect(consumeBlockedReason(verified, { ...binding, tenantId: "t2" }, now)).toBe("not_found")
    expect(consumeBlockedReason(null, binding, now)).toBe("not_found")
  })

  it("refuses an unverified code and a spent one", () => {
    expect(consumeBlockedReason({ ...verified, verifiedAt: null }, binding, now)).toBe("not_verified")
    expect(consumeBlockedReason({ ...verified, consumedAt: minutes(-0.5) }, binding, now)).toBe("already_used")
  })

  it("refuses a verification older than the 15-minute signing window", () => {
    expect(consumeBlockedReason({ ...verified, verifiedAt: minutes(-15) }, binding, now)).toBeNull()
    expect(consumeBlockedReason({ ...verified, verifiedAt: new Date(minutes(-15).getTime() - 1) }, binding, now))
      .toBe("verification_stale")
  })
})

describe("signingOtpRequired", () => {
  it("requires a code for portal signing when the lender requires it", () => {
    expect(signingOtpRequired({ requireSigningOtp: true, signingOtpBranchExempt: true }, "portal")).toBe(true)
    expect(signingOtpRequired({ requireSigningOtp: false, signingOtpBranchExempt: true }, "portal")).toBe(false)
  })

  it("exempts witnessed branch signing unless the lender removes the exemption", () => {
    expect(signingOtpRequired({ requireSigningOtp: true, signingOtpBranchExempt: true }, "branch")).toBe(false)
    expect(signingOtpRequired({ requireSigningOtp: true, signingOtpBranchExempt: false }, "branch")).toBe(true)
    expect(signingOtpRequired({ requireSigningOtp: false, signingOtpBranchExempt: false }, "branch")).toBe(false)
  })
})
