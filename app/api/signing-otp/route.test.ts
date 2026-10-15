import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const h = vi.hoisted(() => ({
  session: null as null | { user: Record<string, unknown> },
  tenantConfig: null as null | Record<string, unknown>,
  resolveSubject: vi.fn(),
  request: vi.fn(),
}))

vi.mock("@/lib/auth", () => ({ auth: async () => h.session }))
vi.mock("@/lib/tenant", () => ({
  withTenantContext: (_req: unknown, fn: (t: { id: string }) => unknown) => fn({ id: "t1" }),
}))
vi.mock("@/lib/prisma", () => ({ prisma: { tenantConfig: { findUnique: async () => h.tenantConfig } } }))
vi.mock("@/lib/signing-otp/subject", async (orig) => ({
  ...(await orig<typeof import("@/lib/signing-otp/subject")>()),
  resolveSigningSubject: (...a: unknown[]) => h.resolveSubject(...a),
}))
vi.mock("@/lib/signing-otp/request", () => ({ requestSigningOtp: (...a: unknown[]) => h.request(...a) }))

import { POST } from "./route"
import { _resetRateLimitStore } from "@/lib/rate-limit"

const DIGEST = "a".repeat(64)
const subject = {
  tenantId: "t1", clientId: "client-1", purpose: "AGREEMENT", subjectId: "app-1", documentSha256: DIGEST,
  recipient: { firstName: "A", lastName: "B", email: "a@example.invalid", whatsapp: null },
}
const body = { purpose: "AGREEMENT", subjectId: "app-1", documentSha256: DIGEST, channel: "EMAIL" }
const post = (b: unknown) => POST(new NextRequest("http://localhost/api/signing-otp", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b),
}))
const asClient = (id = "client-1") => ({ user: { id, role: "CLIENT", email: "a@example.invalid", tenantId: "t1" } })
const asStaff = (role = "CREDIT_OFFICER") => ({
  user: { id: "u1", role, email: "o@example.invalid", tenantId: "t1", totpEnrolmentRequired: false },
})

beforeEach(() => {
  _resetRateLimitStore()
  h.session = asClient()
  h.tenantConfig = null
  h.resolveSubject.mockReset().mockResolvedValue({ ok: true, subject })
  h.request.mockReset().mockResolvedValue({
    ok: true,
    challenge: { challengeId: "otp-1", channel: "EMAIL", maskedDestination: "a***@e***.invalid", expiresAt: "x" },
  })
})

describe("POST /api/signing-otp", () => {
  it("issues a code to the borrower for their own document, as a portal signing", async () => {
    const res = await post(body)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(expect.objectContaining({ challengeId: "otp-1" }))
    expect(h.request).toHaveBeenCalledWith(expect.objectContaining({ subject, channel: "EMAIL", method: "portal" }))
  })

  it("401s without a session", async () => {
    h.session = null
    expect((await post(body)).status).toBe(401)
  })

  it("will not issue a code for another client's document, and says only 'not found'", async () => {
    h.session = asClient("client-2")
    const res = await post(body)
    expect(res.status).toBe(404)
    expect(h.request).not.toHaveBeenCalled()
  })

  it("refuses when the bytes on screen are not the current bytes", async () => {
    const res = await post({ ...body, documentSha256: "b".repeat(64) })
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual(expect.objectContaining({ signingOtp: "document_changed" }))
    expect(h.request).not.toHaveBeenCalled()
  })

  it("accepts only EMAIL or WHATSAPP — never SMS", async () => {
    expect((await post({ ...body, channel: "SMS" })).status).toBe(400)
    expect(h.request).not.toHaveBeenCalled()
  })

  it("409s when the lender does not require a code", async () => {
    h.tenantConfig = { requireSigningOtp: false, signingOtpBranchExempt: true }
    expect((await post(body)).status).toBe(409)
  })

  it("lets a credit officer request a branch code only when the branch exemption is off", async () => {
    h.session = asStaff()
    expect((await post(body)).status).toBe(409)
    h.tenantConfig = { requireSigningOtp: true, signingOtpBranchExempt: false }
    expect((await post(body)).status).toBe(200)
    expect(h.request).toHaveBeenCalledWith(expect.objectContaining({ method: "branch", actor: { userId: "u1", email: "o@example.invalid" } }))
  })

  it("keeps the debit mandate a portal-only signature", async () => {
    h.session = asStaff()
    h.tenantConfig = { requireSigningOtp: true, signingOtpBranchExempt: false }
    expect((await post({ ...body, purpose: "DEBIT_MANDATE" })).status).toBe(403)
  })

  it("refuses staff below credit officer", async () => {
    h.session = asStaff("READONLY")
    expect((await post(body)).status).toBe(403)
  })

  it("passes the service's refusal through with its status", async () => {
    h.request.mockResolvedValue({ ok: false, status: 429, error: "Too many codes requested.", retryAfterSeconds: 900 })
    const res = await post(body)
    expect(res.status).toBe(429)
    expect(res.headers.get("Retry-After")).toBe("900")
  })
})
