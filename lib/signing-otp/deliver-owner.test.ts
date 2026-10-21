import { beforeEach, describe, expect, it, vi } from "vitest"

const m = vi.hoisted(() => ({ resolveMessagingTarget: vi.fn(), deliverViaMessaging: vi.fn(), ensureOtpMessageTemplate: vi.fn() }))
vi.mock("@/lib/prisma", () => ({ prisma: {} }))
vi.mock("@/lib/messaging/route-delivery", () => ({ resolveMessagingTarget: m.resolveMessagingTarget, deliverViaMessaging: m.deliverViaMessaging }))
vi.mock("@/lib/messaging/otp-templates", () => ({ ensureOtpMessageTemplate: m.ensureOtpMessageTemplate }))

import { deliverOtp } from "./deliver"

const args = {
  tenantId: "tn1", clientId: "cl-signer", channel: "EMAIL" as const, destination: "signer@example.test",
  recipient: { firstName: "Thandi", lastName: "Test", email: "signer@example.test", whatsapp: null },
  templateKey: "signing_otp_email", vars: { otp: "123456" }, idempotencyKey: "signing-otp:c1:EMAIL",
}

beforeEach(() => {
  vi.clearAllMocks()
  m.ensureOtpMessageTemplate.mockResolvedValue({ id: "tpl", key: "signing_otp_email" })
  m.deliverViaMessaging.mockResolvedValue({ ok: true, providerOutcome: "ACCEPTED" })
})

// A signing or portal code goes only to the client's own Contact: an address that
// resolves to someone else's would have their consent checked and the code filed under them.
describe("deliverOtp", () => {
  it("resolves the recipient as the signer's own Contact", async () => {
    m.resolveMessagingTarget.mockResolvedValue({ ok: true, contact: { id: "ct1" }, template: { id: "tpl" } })
    await deliverOtp(args)
    expect(m.resolveMessagingTarget).toHaveBeenCalledWith(expect.objectContaining({ ownerClientId: "cl-signer", value: "signer@example.test" }))
  })

  it("sends nothing when the Contact is someone else's", async () => {
    m.resolveMessagingTarget.mockResolvedValue({ ok: false, reason: "the Contact for this email address belongs to someone else" })
    const result = await deliverOtp(args)
    expect(result).toEqual({ status: "FAILED", error: "the Contact for this email address belongs to someone else" })
    expect(m.deliverViaMessaging).not.toHaveBeenCalled()
  })
})
