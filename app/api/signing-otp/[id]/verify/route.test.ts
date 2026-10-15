import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const h = vi.hoisted(() => ({
  session: null as null | { user: Record<string, unknown> },
  findFirst: vi.fn(),
  verify: vi.fn(),
  audit: vi.fn(),
}))

vi.mock("@/lib/auth", () => ({ auth: async () => h.session }))
vi.mock("@/lib/tenant", () => ({
  withTenantContext: (_req: unknown, fn: (t: { id: string }) => unknown) => fn({ id: "t1" }),
}))
vi.mock("@/lib/prisma", () => ({ prisma: { signingOtpChallenge: { findFirst: (...a: unknown[]) => h.findFirst(...a) } } }))
vi.mock("@/lib/audit", () => ({
  logAudit: (...a: unknown[]) => h.audit(...a),
  AuditAction: new Proxy({}, { get: (_t, k) => String(k) }),
}))
vi.mock("@/lib/signing-otp/challenge", async (orig) => ({
  ...(await orig<typeof import("@/lib/signing-otp/challenge")>()),
  verifySigningOtp: (...a: unknown[]) => h.verify(...a),
}))

import { POST } from "./route"
import { _resetRateLimitStore } from "@/lib/rate-limit"

const ctx = { params: Promise.resolve({ id: "otp-1" }) }
const post = (b: unknown) => POST(new NextRequest("http://localhost/api/signing-otp/otp-1/verify", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b),
}), ctx)
const row = { id: "otp-1", clientId: "client-1", purpose: "AGREEMENT", subjectId: "app-1" }

beforeEach(() => {
  _resetRateLimitStore()
  h.session = { user: { id: "client-1", role: "CLIENT", email: "a@example.invalid", tenantId: "t1" } }
  h.findFirst.mockReset().mockResolvedValue(row)
  h.verify.mockReset().mockResolvedValue({ ok: true })
  h.audit.mockReset().mockResolvedValue(undefined)
})

describe("POST /api/signing-otp/[id]/verify", () => {
  it("verifies the borrower's own challenge and audits it", async () => {
    const res = await post({ code: "123456" })
    expect(res.status).toBe(200)
    expect(h.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "otp-1", tenantId: "t1", clientId: "client-1" },
    }))
    expect(h.verify).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ challengeId: "otp-1", clientId: "client-1", code: "123456" }))
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "SIGNING_OTP_VERIFIED", entityId: "app-1" }))
  })

  it("does not find another client's challenge", async () => {
    h.findFirst.mockResolvedValue(null)
    const res = await post({ code: "123456" })
    expect(res.status).toBe(404)
    expect(h.verify).not.toHaveBeenCalled()
  })

  it("lets staff verify only branch challenges (ones a witness requested)", async () => {
    h.session = { user: { id: "u1", role: "CREDIT_OFFICER", email: "o@example.invalid", tenantId: "t1", totpEnrolmentRequired: false } }
    await post({ code: "123456" })
    expect(h.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "otp-1", tenantId: "t1", requestedByUserId: { not: null } },
    }))
  })

  it.each([
    ["wrong_code", 400], ["expired", 410], ["locked", 429], ["already_used", 409], ["delivery_failed", 409],
  ] as const)("maps %s to %i and audits the rejection", async (reason, status) => {
    h.verify.mockResolvedValue({ ok: false, reason, attemptsLeft: reason === "wrong_code" ? 3 : undefined })
    const res = await post({ code: "000000" })
    expect(res.status).toBe(status)
    expect(await res.json()).toEqual(expect.objectContaining({ signingOtp: reason }))
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: "SIGNING_OTP_REJECTED",
      newValue: expect.objectContaining({ reason }),
    }))
  })

  it("never writes the submitted code into the audit row", async () => {
    h.verify.mockResolvedValue({ ok: false, reason: "wrong_code", attemptsLeft: 4 })
    await post({ code: "246813" })
    expect(JSON.stringify(h.audit.mock.calls)).not.toContain("246813")
  })

  it("400s without a code", async () => {
    expect((await post({})).status).toBe(400)
  })
})
