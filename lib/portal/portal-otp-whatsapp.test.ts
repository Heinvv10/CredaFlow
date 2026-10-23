import { describe, expect, it, vi } from "vitest"

const m = vi.hoisted(() => ({ deliverOtp: vi.fn() }))
vi.mock("@/lib/signing-otp/deliver", async (orig) => ({ ...(await orig<typeof import("@/lib/signing-otp/deliver")>()), deliverOtp: m.deliverOtp }))
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn(), AuditAction: {} }))

import { sendPortalOtpByWhatsApp } from "./portal-otp-whatsapp"

describe("sendPortalOtpByWhatsApp", () => {
  it("sends the code only to the client's own Contact", async () => {
    m.deliverOtp.mockResolvedValue({ status: "ACCEPTED" })
    await sendPortalOtpByWhatsApp({
      tenantId: "tn1",
      client: { id: "cl-portal", firstName: "Thandi", lastName: "Test", email: null, whatsapp: "0820000001" },
      code: "123456", purpose: "activation", otpRecordId: "otp-1",
    })
    expect(m.deliverOtp).toHaveBeenCalledWith(expect.objectContaining({ clientId: "cl-portal", channel: "WHATSAPP" }))
  })
})
