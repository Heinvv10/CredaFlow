import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const clientOtpFindFirstMock = vi.fn()
const clientOtpUpdateMock = vi.fn()
const clientFindFirstMock = vi.fn()
const clientUpdateMock = vi.fn()
const checkRateLimitMock = vi.fn()
const withTenantContextMock = vi.fn()
const bcryptHashMock = vi.fn()
// The lender's TenantConfig row; null = no row = portal on.
const portalConfig = vi.hoisted(() => ({ row: null as null | Record<string, unknown> }))

vi.mock("@/lib/prisma", () => ({
  prisma: {
    clientOtp: {
      findFirst: (a: unknown) => clientOtpFindFirstMock(a),
      update: (a: unknown) => clientOtpUpdateMock(a),
    },
    client: {
      findFirst: (a: unknown) => clientFindFirstMock(a),
      update: (a: unknown) => clientUpdateMock(a),
    },
    tenantConfig: { findUnique: async () => portalConfig.row },
  },
}))
vi.mock("bcryptjs", () => ({ default: { hash: (...a: unknown[]) => bcryptHashMock(...a) } }))
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: (key: string, conf: unknown) => checkRateLimitMock(key, conf),
  callerIp: () => "127.0.0.1",
}))
vi.mock("@/lib/tenant", () => ({
  withTenantContext: (req: unknown, cb: (t: { id: string }) => Promise<unknown>) =>
    withTenantContextMock(req, cb),
}))

import { POST } from "./route"

function buildReq(body: object): NextRequest {
  return new NextRequest("https://staging.acme-lending.example/api/portal/reset-password", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

const validBody = {
  email: "user@example.com",
  otp: "123456",
  password: "newpassword1",
  confirmPassword: "newpassword1",
}

beforeEach(() => {
  vi.resetAllMocks()
  checkRateLimitMock.mockReturnValue({ allowed: true })
  withTenantContextMock.mockImplementation(async (_req, cb) => cb({ id: "tenant_acme" }))
  bcryptHashMock.mockResolvedValue("hashed-pw")
  clientOtpFindFirstMock.mockResolvedValue({ id: "otp_a", otp: "123456", used: false })
  clientOtpUpdateMock.mockResolvedValue({ id: "otp_a" })
  clientFindFirstMock.mockResolvedValue({ id: "cl_a", email: "user@example.com", tenantId: "tenant_acme" })
  clientUpdateMock.mockResolvedValue({ id: "cl_a" })
  portalConfig.row = null
})

describe("POST /api/portal/reset-password — lender portal switched off", () => {
  it("404s with the portal-unavailable answer and never checks a code or changes a password", async () => {
    portalConfig.row = { featurePortal: false }
    const res = await POST(buildReq(validBody))
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual(expect.objectContaining({ portal: "disabled" }))
    expect(clientOtpFindFirstMock).not.toHaveBeenCalled()
    expect(clientUpdateMock).not.toHaveBeenCalled()
  })
})

describe("POST /api/portal/reset-password", () => {
  it("valid OTP: 200, sets hashed password, marks OTP used", async () => {
    const res = await POST(buildReq(validBody))
    expect(res.status).toBe(200)
    expect(clientUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({ data: { portalPassword: "hashed-pw" } }),
    )
    expect(clientOtpUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({ data: { used: true } }),
    )
  })

  it("wrong OTP: 400, never updates the password", async () => {
    const res = await POST(buildReq({ ...validBody, otp: "000000" }))
    expect(res.status).toBe(400)
    expect(clientUpdateMock).not.toHaveBeenCalled()
    expect(clientOtpUpdateMock).not.toHaveBeenCalled()
  })

  it("no unused/unexpired OTP record: 400", async () => {
    clientOtpFindFirstMock.mockResolvedValue(null)
    const res = await POST(buildReq(validBody))
    expect(res.status).toBe(400)
    expect(clientUpdateMock).not.toHaveBeenCalled()
  })

  it("per-email cap exceeded (IP cap OK): 429 BEFORE any OTP lookup", async () => {
    // The load-bearing brute-force bound: keyed on the target email, it trips
    // even when the source IP is fresh (distributed / rotating-proxy attack).
    checkRateLimitMock.mockImplementation((key: string) =>
      key.startsWith("reset-otp:acct:")
        ? { allowed: false, retryAfterSeconds: 60 }
        : { allowed: true },
    )
    const res = await POST(buildReq(validBody))
    expect(res.status).toBe(429)
    expect(checkRateLimitMock).toHaveBeenCalledWith(
      "reset-otp:acct:user@example.com",
      expect.anything(),
    )
    expect(clientOtpFindFirstMock).not.toHaveBeenCalled()
    expect(clientUpdateMock).not.toHaveBeenCalled()
  })

  it("per-IP cap exceeded: 429", async () => {
    checkRateLimitMock.mockImplementation((key: string) =>
      key === "reset-otp:127.0.0.1"
        ? { allowed: false, retryAfterSeconds: 60 }
        : { allowed: true },
    )
    const res = await POST(buildReq(validBody))
    expect(res.status).toBe(429)
    expect(clientOtpFindFirstMock).not.toHaveBeenCalled()
  })

  it("missing fields: 400", async () => {
    const res = await POST(buildReq({ email: "user@example.com" }))
    expect(res.status).toBe(400)
  })

  it("password too short: 400", async () => {
    const res = await POST(buildReq({ ...validBody, password: "short", confirmPassword: "short" }))
    expect(res.status).toBe(400)
  })

  it("passwords do not match: 400", async () => {
    const res = await POST(buildReq({ ...validBody, confirmPassword: "different1" }))
    expect(res.status).toBe(400)
  })
})
