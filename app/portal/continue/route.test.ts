import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const getTenantFromRequestMock = vi.fn()
const checkRateLimitMock = vi.fn()
const findFirstClientMock = vi.fn()

vi.mock("@/lib/prisma", () => ({
  prisma: { client: { findFirst: (a: unknown) => findFirstClientMock(a) } },
}))
vi.mock("@/lib/tenant", () => ({
  getTenantFromRequest: (...args: unknown[]) => getTenantFromRequestMock(...args),
}))
vi.mock("@/lib/tenant-scope", () => ({
  runWithTenant: (_id: string, fn: () => unknown) => fn(),
}))
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: (key: string, conf: unknown) => checkRateLimitMock(key, conf),
  callerIp: () => "127.0.0.1",
}))

import { GET } from "./route"

const LOGIN = "/portal/login?callbackUrl=%2Fportal%2Fapplications"

function req(qs: string): NextRequest {
  return new NextRequest(`https://portal.acme-lending.example/portal/continue?${qs}`)
}

describe("GET /portal/continue", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    checkRateLimitMock.mockReturnValue({ allowed: true, retryAfterSeconds: 0 })
    getTenantFromRequestMock.mockResolvedValue({ id: "t1" })
  })

  it("routes a registered client (password set) to login", async () => {
    findFirstClientMock.mockResolvedValue({ portalPassword: "hash" })
    const res = await GET(req("email=a@b.com&reference=REF1"))
    expect(res.status).toBe(303)
    expect(res.headers.get("location")).toBe(LOGIN)
  })

  it("routes an applied-but-unregistered client to register, prefilled", async () => {
    findFirstClientMock.mockResolvedValue({ portalPassword: null })
    const res = await GET(req("email=a@b.com&reference=REF1"))
    expect(res.status).toBe(303)
    expect(res.headers.get("location")).toBe("/portal/register?email=a%40b.com&reference=REF1")
  })

  it("routes to register when email+reference match no application (no account oracle)", async () => {
    findFirstClientMock.mockResolvedValue(null)
    const res = await GET(req("email=probe@x.com&reference=GUESS"))
    expect(res.headers.get("location")).toContain("/portal/register")
  })

  it("gives a byte-identical register Location for no-match vs applied-unregistered (anti-enumeration invariant)", async () => {
    const qs = "email=same@x.com&reference=REF9"
    findFirstClientMock.mockResolvedValueOnce({ portalPassword: null })
    const applied = await GET(req(qs))
    findFirstClientMock.mockResolvedValueOnce(null)
    const noMatch = await GET(req(qs))
    // Both non-registered states MUST be indistinguishable, or the endpoint
    // leaks whether the (email, reference) pair belongs to a real customer.
    expect(applied.headers.get("location")).toBe(noMatch.headers.get("location"))
    expect(noMatch.headers.get("location")).toBe("/portal/register?email=same%40x.com&reference=REF9")
  })

  it("skips the DB lookup and routes to register when reference is missing", async () => {
    const res = await GET(req("email=a@b.com"))
    expect(res.headers.get("location")).toContain("/portal/register")
    expect(findFirstClientMock).not.toHaveBeenCalled()
  })

  it("routes to register without a lookup when rate-limited", async () => {
    checkRateLimitMock.mockReturnValue({ allowed: false, retryAfterSeconds: 60 })
    const res = await GET(req("email=a@b.com&reference=REF1"))
    expect(res.headers.get("location")).toContain("/portal/register")
    expect(findFirstClientMock).not.toHaveBeenCalled()
  })

  it("lower-cases the email before matching", async () => {
    findFirstClientMock.mockResolvedValue({ portalPassword: "hash" })
    await GET(req("email=Mixed@CASE.com&reference=REF1"))
    expect(findFirstClientMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ email: "mixed@case.com" }) }),
    )
  })

  // `next` exists so a "sign your agreement" link survives the login/register
  // detour. It must survive BOTH branches — an unregistered customer losing it
  // is the exact dead end this endpoint was extended to close.
  describe("next (deep-link destination)", () => {
    const SIGN = "/portal/agreement/app123"

    it("sends a registered client to login with `next` as the callbackUrl", async () => {
      findFirstClientMock.mockResolvedValue({ portalPassword: "hash" })
      const res = await GET(req(`email=a@b.com&reference=REF1&next=${encodeURIComponent(SIGN)}`))
      expect(res.headers.get("location"))
        .toBe(`/portal/login?callbackUrl=${encodeURIComponent(SIGN)}`)
    })

    it("carries `next` through registration for an unregistered client", async () => {
      findFirstClientMock.mockResolvedValue({ portalPassword: null })
      const res = await GET(req(`email=a@b.com&reference=REF1&next=${encodeURIComponent(SIGN)}`))
      expect(res.headers.get("location"))
        .toBe(`/portal/register?email=a%40b.com&reference=REF1&next=${encodeURIComponent(SIGN)}`)
    })

    it("falls back to the applications list when `next` is absent", async () => {
      findFirstClientMock.mockResolvedValue({ portalPassword: "hash" })
      const res = await GET(req("email=a@b.com&reference=REF1"))
      expect(res.headers.get("location")).toBe(LOGIN)
    })

    // An unvalidated `next` would turn this endpoint — which we put in emails —
    // into an open redirect off a trusted lender domain.
    it.each([
      ["protocol-relative", "//evil.example/x"],
      ["absolute", "https://evil.example/x"],
      ["backslash escape", "/portal/\\evil.example"],
      ["non-portal path", "/admin/users"],
    ])("strips an unsafe `next` (%s) on the login branch", async (_label, bad) => {
      findFirstClientMock.mockResolvedValue({ portalPassword: "hash" })
      const res = await GET(req(`email=a@b.com&reference=REF1&next=${encodeURIComponent(bad)}`))
      expect(res.headers.get("location")).toBe(LOGIN)
      expect(res.headers.get("location")).not.toContain("evil.example")
    })

    it.each([
      ["protocol-relative", "//evil.example/x"],
      ["absolute", "https://evil.example/x"],
      ["backslash escape", "/portal/\\evil.example"],
      ["non-portal path", "/admin/users"],
    ])("strips an unsafe `next` (%s) on the register branch", async (_label, bad) => {
      findFirstClientMock.mockResolvedValue({ portalPassword: null })
      const res = await GET(req(`email=a@b.com&reference=REF1&next=${encodeURIComponent(bad)}`))
      expect(res.headers.get("location")).toBe("/portal/register?email=a%40b.com&reference=REF1")
      expect(res.headers.get("location")).not.toContain("evil.example")
    })

    it("keeps both non-registered states byte-identical when `next` is present", async () => {
      const qs = `email=same@x.com&reference=REF9&next=${encodeURIComponent(SIGN)}`
      findFirstClientMock.mockResolvedValueOnce({ portalPassword: null })
      const applied = await GET(req(qs))
      findFirstClientMock.mockResolvedValueOnce(null)
      const noMatch = await GET(req(qs))
      expect(applied.headers.get("location")).toBe(noMatch.headers.get("location"))
    })
  })
})
