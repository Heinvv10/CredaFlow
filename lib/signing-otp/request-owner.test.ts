import { describe, expect, it, vi } from "vitest"

const m = vi.hoisted(() => ({ deliverOtp: vi.fn() }))
vi.mock("@/lib/prisma", () => {
  const tx = {
    $executeRaw: vi.fn(async () => 0),
    signingOtpChallenge: { count: vi.fn(async () => 0), create: vi.fn(async () => ({})) },
  }
  return {
    prisma: {
      $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
      signingOtpChallenge: { updateMany: vi.fn(async () => ({ count: 1 })) },
    },
  }
})
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn(), AuditAction: { SIGNING_OTP_REQUESTED: "SIGNING_OTP_REQUESTED" } }))
vi.mock("./deliver", async (orig) => ({ ...(await orig<typeof import("./deliver")>()), deliverOtp: m.deliverOtp }))

import { requestSigningOtp } from "./request"

// The signing code goes only to the signer's own Contact (lib/contact/recipient.ts): the
// request hands deliverOtp the Client the code is for.
describe("requestSigningOtp", () => {
  it("passes the signer's client id to the delivery", async () => {
    vi.stubEnv("AUTH_SECRET", "synthetic-test-secret")
    m.deliverOtp.mockResolvedValue({ status: "ACCEPTED" })
    const result = await requestSigningOtp({
      subject: {
        tenantId: "tn1", clientId: "cl-signer", purpose: "DOCUMENT", subjectId: "doc-1", documentSha256: "a".repeat(64),
        recipient: { firstName: "Thandi", lastName: "Test", email: "signer@example.test", whatsapp: null },
      },
      channel: "EMAIL", method: "portal", ip: null, actor: {},
    })
    expect(result.ok).toBe(true)
    expect(m.deliverOtp).toHaveBeenCalledWith(expect.objectContaining({ clientId: "cl-signer", destination: "signer@example.test" }))
    vi.unstubAllEnvs()
  })
})
