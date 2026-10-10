import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { NextRequest } from "next/server"

const clientFindFirstMock = vi.fn()
const clientOtpCreateMock = vi.fn()
const messageTemplateFindFirstMock = vi.fn()
const sendEmailMock = vi.fn()
const sendMessageMock = vi.fn()
const lookupContactMock = vi.fn()
const checkRateLimitMock = vi.fn()
const withTenantContextMock = vi.fn()
const verifyTurnstileMock = vi.fn()
const findLenderIdentityMock = vi.fn()

vi.mock("@/lib/prisma", () => ({
  prisma: {
    client: { findFirst: (a: unknown) => clientFindFirstMock(a) },
    clientOtp: { create: (a: unknown) => clientOtpCreateMock(a) },
    messageTemplate: { findFirst: (a: unknown) => messageTemplateFindFirstMock(a) },
  },
}))
vi.mock("@/lib/config/identity", () => ({
  findLenderIdentity: (...args: unknown[]) => findLenderIdentityMock(...args),
}))
vi.mock("@/lib/email/service", () => ({ sendEmail: (a: unknown) => sendEmailMock(a) }))
vi.mock("@/lib/messaging/send", () => ({ sendMessage: (a: unknown) => sendMessageMock(a) }))
vi.mock("@/lib/contact/identity", async (orig) => {
  const real = (await orig()) as Record<string, unknown>
  return { ...real, lookupContactByChannelValue: (...args: unknown[]) => lookupContactMock(...args) }
})
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: (key: string, conf: unknown) => checkRateLimitMock(key, conf),
  callerIp: () => "127.0.0.1",
}))
vi.mock("@/lib/tenant", () => ({
  withTenantContext: (req: unknown, cb: (t: { id: string }) => Promise<unknown>) =>
    withTenantContextMock(req, cb),
}))
vi.mock("@/lib/turnstile", () => ({
  verifyTurnstile: (...args: unknown[]) => verifyTurnstileMock(...args),
}))

import { POST } from "./route"

function buildReq(body: object): NextRequest {
  return new NextRequest("https://portal.lender.example/api/portal/forgot-password", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  vi.resetAllMocks()
  checkRateLimitMock.mockReturnValue({ allowed: true })
  verifyTurnstileMock.mockResolvedValue({ ok: true })
  withTenantContextMock.mockImplementation(async (_req, cb) => cb({ id: "tenant_acme" }))
  clientFindFirstMock.mockResolvedValue({
    id: "cl_a",
    email: "user@example.com",
    firstName: "Alice",
    lastName: "X",
    tenantId: "tenant_acme",
  })
  clientOtpCreateMock.mockResolvedValue({ id: "otp_a" })
  findLenderIdentityMock.mockImplementation(async () => {
    const { parseLenderIdentity } = await vi.importActual<typeof import("@/lib/config/identity")>("@/lib/config/identity")
    const { VALID_LENDER_COLUMNS } = await import("@/lib/config/__fixtures__/lender-identity")
    return parseLenderIdentity(VALID_LENDER_COLUMNS)
  })
  sendEmailMock.mockResolvedValue({ ok: true })
  sendMessageMock.mockResolvedValue({ id: "msg_a" })
  lookupContactMock.mockResolvedValue({ id: "ct_a", tenantId: "tenant_acme" })
  messageTemplateFindFirstMock.mockResolvedValue({
    id: "tpl_a",
    tenantId: "tenant_acme",
    key: "portal_forgot_password_email",
    channel: "EMAIL",
    category: "TRANSACTIONAL",
    body: "code: {{otp}}",
    bodyTemplate: "<p>{{firstName}}: {{otp}}</p>",
    subject: "Reset code",
    statutoryOverride: false,
    purposeRequired: null,
  })
})

afterEach(() => {
  delete process.env.MESSAGING_NEW_SEND_PORTAL_FORGOT
})

describe("POST /api/portal/forgot-password", () => {
  // An unconfigured lender identity must not become an account-existence
  // oracle: known and unknown emails get the same answer, and nothing is sent.
  it("FLAG OFF + identity not configured: identical 503 for known and unknown emails, no OTP, no send", async () => {
    delete process.env.MESSAGING_NEW_SEND_PORTAL_FORGOT
    findLenderIdentityMock.mockResolvedValue(null)
    const known = await POST(buildReq({ email: "user@example.com" }))
    clientFindFirstMock.mockResolvedValue(null)
    const unknown = await POST(buildReq({ email: "nobody@example.com" }))
    expect(known.status).toBe(503)
    expect(unknown.status).toBe(known.status)
    expect(await unknown.json()).toEqual(await known.json())
    expect(clientOtpCreateMock).not.toHaveBeenCalled()
    expect(sendEmailMock).not.toHaveBeenCalled()
  })

  it("FLAG OFF: uses legacy sendEmail, never touches sendMessage", async () => {
    delete process.env.MESSAGING_NEW_SEND_PORTAL_FORGOT
    const res = await POST(buildReq({ email: "user@example.com" }))
    expect(res.status).toBe(200)
    expect(sendEmailMock).toHaveBeenCalledTimes(1)
    expect(sendMessageMock).not.toHaveBeenCalled()
    expect(lookupContactMock).not.toHaveBeenCalled()
    expect(messageTemplateFindFirstMock).not.toHaveBeenCalled()
  })

  it("FLAG ON + known client + known contact + template found: calls sendMessage, NOT sendEmail", async () => {
    process.env.MESSAGING_NEW_SEND_PORTAL_FORGOT = "true"
    const res = await POST(buildReq({ email: "user@example.com" }))
    expect(res.status).toBe(200)
    expect(sendEmailMock).not.toHaveBeenCalled()
    expect(sendMessageMock).toHaveBeenCalledTimes(1)
    expect(sendMessageMock.mock.calls[0][0]).toMatchObject({
      contactId: "ct_a",
      channel: "EMAIL",
      toValue: "user@example.com",
    })
    expect(sendMessageMock.mock.calls[0][0].vars).toMatchObject({
      firstName: "Alice",
      otp: expect.stringMatching(/^\d{6}$/),
    })
    expect(clientOtpCreateMock).toHaveBeenCalledTimes(1)
  })

  it("FLAG ON + sendMessage throws: 200 still returned (fire-and-forget)", async () => {
    process.env.MESSAGING_NEW_SEND_PORTAL_FORGOT = "true"
    sendMessageMock.mockRejectedValue(new Error("dispatch transient failure"))
    const res = await POST(buildReq({ email: "user@example.com" }))
    // The OTP row is already written; a transient send failure must not
    // 500 the route. The user can re-request a code on the next screen.
    expect(res.status).toBe(200)
    expect(sendMessageMock).toHaveBeenCalledTimes(1)
    expect(clientOtpCreateMock).toHaveBeenCalledTimes(1)
  })

  it("FLAG ON + client missing: 200 + no sendMessage + no sendEmail", async () => {
    process.env.MESSAGING_NEW_SEND_PORTAL_FORGOT = "true"
    clientFindFirstMock.mockResolvedValue(null)
    const res = await POST(buildReq({ email: "ghost@example.com" }))
    expect(res.status).toBe(200)
    expect(sendMessageMock).not.toHaveBeenCalled()
    expect(sendEmailMock).not.toHaveBeenCalled()
  })

  it("FLAG ON + client found + contact missing (data drift): 200 + no sendMessage", async () => {
    process.env.MESSAGING_NEW_SEND_PORTAL_FORGOT = "true"
    lookupContactMock.mockResolvedValue(null)
    const res = await POST(buildReq({ email: "user@example.com" }))
    expect(res.status).toBe(200)
    expect(sendMessageMock).not.toHaveBeenCalled()
    expect(sendEmailMock).not.toHaveBeenCalled()
  })

  it("FLAG ON + template missing (DB-not-seeded): 200 + no sendMessage + no leakage", async () => {
    process.env.MESSAGING_NEW_SEND_PORTAL_FORGOT = "true"
    messageTemplateFindFirstMock.mockResolvedValue(null)
    const res = await POST(buildReq({ email: "user@example.com" }))
    expect(res.status).toBe(200)
    expect(sendMessageMock).not.toHaveBeenCalled()
    expect(sendEmailMock).not.toHaveBeenCalled()
  })

  it("rate limit exceeded: 429 regardless of flag", async () => {
    process.env.MESSAGING_NEW_SEND_PORTAL_FORGOT = "true"
    checkRateLimitMock.mockReturnValue({ allowed: false, retryAfterSeconds: 60 })
    const res = await POST(buildReq({ email: "user@example.com" }))
    expect(res.status).toBe(429)
    expect(sendMessageMock).not.toHaveBeenCalled()
    expect(sendEmailMock).not.toHaveBeenCalled()
  })

  it("missing email body: 400", async () => {
    process.env.MESSAGING_NEW_SEND_PORTAL_FORGOT = "true"
    const res = await POST(buildReq({}))
    expect(res.status).toBe(400)
  })

  it("Turnstile fails: 400, no OTP created, no send", async () => {
    verifyTurnstileMock.mockResolvedValue({ ok: false, errorCodes: ["missing-token"] })
    const res = await POST(buildReq({ email: "user@example.com" }))
    expect(res.status).toBe(400)
    expect(clientOtpCreateMock).not.toHaveBeenCalled()
    expect(sendMessageMock).not.toHaveBeenCalled()
    expect(sendEmailMock).not.toHaveBeenCalled()
  })

  it("passes the submitted token to verifyTurnstile", async () => {
    await POST(buildReq({ email: "user@example.com", turnstileToken: "solved-token" }))
    expect(verifyTurnstileMock).toHaveBeenCalledWith("solved-token", "127.0.0.1")
  })

  it("per-email cap exceeded (IP cap OK): 429, no OTP created", async () => {
    // IP anti-amplification cap passes; the per-email gate is the one that trips.
    checkRateLimitMock.mockImplementation((key: string) =>
      key.startsWith("forgot:acct:")
        ? { allowed: false, retryAfterSeconds: 60 }
        : { allowed: true },
    )
    const res = await POST(buildReq({ email: "user@example.com" }))
    expect(res.status).toBe(429)
    expect(checkRateLimitMock).toHaveBeenCalledWith(
      "forgot:acct:user@example.com",
      expect.anything(),
    )
    expect(clientOtpCreateMock).not.toHaveBeenCalled()
    expect(sendMessageMock).not.toHaveBeenCalled()
    expect(sendEmailMock).not.toHaveBeenCalled()
  })
})

// DEMO_MODE: the reset code goes to a fictional address and never arrives,
// so a demo deployment returns it to the request that issued it. Anything but
// the exact string "true" must keep it out of the response.
describe("POST /api/portal/forgot-password — DEMO_MODE reset code reveal", () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  function issuedCode(): string {
    return (clientOtpCreateMock.mock.calls[0][0] as { data: { otp: string } }).data.otp
  }

  it.each([
    ["legacy send", undefined, () => {}],
    ["new send pipeline", "true", () => {}],
    ["new send, Contact missing", "true", () => lookupContactMock.mockResolvedValue(null)],
    ["new send, template missing", "true", () => messageTemplateFindFirstMock.mockResolvedValue(null)],
  ])("returns the issued code when DEMO_MODE=true (%s)", async (_label, newSend, arrange) => {
    vi.stubEnv("DEMO_MODE", "true")
    if (newSend) process.env.MESSAGING_NEW_SEND_PORTAL_FORGOT = newSend
    arrange()
    const res = await POST(buildReq({ email: "user@example.com" }))
    const data = await res.json()
    expect(res.status).toBe(200)
    expect(data.demoCode).toMatch(/^\d{6}$/)
    expect(data.demoCode).toBe(issuedCode())
  })

  it.each([undefined, "", "false", "TRUE ", "1"])("never returns the code when DEMO_MODE=%j", async (value) => {
    if (value === undefined) vi.stubEnv("DEMO_MODE", undefined)
    else vi.stubEnv("DEMO_MODE", value)
    const res = await POST(buildReq({ email: "user@example.com" }))
    const data = await res.json()
    expect(clientOtpCreateMock).toHaveBeenCalledTimes(1)
    expect(data).toEqual({ success: true })
  })

  it("returns no code for an unknown email, even in demo mode", async () => {
    vi.stubEnv("DEMO_MODE", "true")
    clientFindFirstMock.mockResolvedValue(null)
    const data = await (await POST(buildReq({ email: "nobody@example.com" }))).json()
    expect(data).toEqual({ success: true })
  })
})
