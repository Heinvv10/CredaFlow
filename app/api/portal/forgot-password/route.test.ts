import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { NextRequest } from "next/server"

const clientFindFirstMock = vi.fn()
const clientOtpCreateMock = vi.fn()
const auditCreateMock = vi.fn()
const messageTemplateFindFirstMock = vi.fn()
const sendEmailMock = vi.fn()
const sendMessageMock = vi.fn()
const lookupContactMock = vi.fn()
const checkRateLimitMock = vi.fn()
const withTenantContextMock = vi.fn()
const verifyTurnstileMock = vi.fn()
const findLenderIdentityMock = vi.fn()

// TenantConfig / CommsSettings rows for the portal switches and the WhatsApp
// leg; null = no row = every default (portal on, no WhatsApp Cloud).
const lenderRows = vi.hoisted(() => ({
  tenantConfig: null as null | Record<string, unknown>,
  commsSettings: null as null | Record<string, unknown>,
}))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: (cb: (tx: unknown) => Promise<unknown>) => cb({ clientOtp: { create: clientOtpCreateMock }, auditLog: { create: auditCreateMock } }),
    client: { findFirst: (a: unknown) => clientFindFirstMock(a) },
    clientOtp: { create: (a: unknown) => clientOtpCreateMock(a) },
    messageTemplate: { findFirst: (a: unknown) => messageTemplateFindFirstMock(a) },
    tenantConfig: { findUnique: async () => lenderRows.tenantConfig },
    commsSettings: { findUnique: async () => lenderRows.commsSettings },
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
const sendPortalOtpByWhatsApp = vi.hoisted(() => vi.fn())
vi.mock("@/lib/portal/portal-otp-whatsapp", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/portal/portal-otp-whatsapp")>()),
  sendPortalOtpByWhatsApp,
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
  auditCreateMock.mockResolvedValue({ id: "audit-synthetic" })
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
  lenderRows.tenantConfig = null
  lenderRows.commsSettings = null
})

describe("POST /api/portal/forgot-password — portal switch and WhatsApp channel", () => {
  const waCloud = { whatsappEnabled: true, waProvider: "WA_CLOUD", wabaPhoneNumberId: "pn-1", wabaAccessToken: "token" }

  it("404s while the lender's portal is off, before any lookup or code", async () => {
    lenderRows.tenantConfig = { featurePortal: false }
    const res = await POST(buildReq({ email: "user@example.com" }))
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual(expect.objectContaining({ portal: "disabled" }))
    expect(clientFindFirstMock).not.toHaveBeenCalled()
    expect(clientOtpCreateMock).not.toHaveBeenCalled()
  })

  it("sends the reset code on WhatsApp when asked and available, and not by email", async () => {
    lenderRows.commsSettings = waCloud
    sendPortalOtpByWhatsApp.mockResolvedValue(undefined)
    clientFindFirstMock.mockResolvedValue({
      id: "cl_a", email: "user@example.com", firstName: "Alice", lastName: "X", tenantId: "tenant_acme", whatsapp: "0820000001",
    })
    const res = await POST(buildReq({ email: "user@example.com", channel: "WHATSAPP" }))
    expect(res.status).toBe(200)
    expect(sendPortalOtpByWhatsApp).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: "tenant_acme", purpose: "password_reset", otpRecordId: "otp_a",
    }))
    expect(sendEmailMock).not.toHaveBeenCalled()
    expect(sendMessageMock).not.toHaveBeenCalled()
  })

  it("answers before the WhatsApp send settles, so timing cannot reveal the account", async () => {
    lenderRows.commsSettings = waCloud
    sendPortalOtpByWhatsApp.mockReturnValue(new Promise(() => undefined))
    clientFindFirstMock.mockResolvedValue({
      id: "cl_a", email: "user@example.com", firstName: "Alice", lastName: "X", tenantId: "tenant_acme", whatsapp: "0820000001",
    })
    const res = await POST(buildReq({ email: "user@example.com", channel: "WHATSAPP" }))
    expect(res.status).toBe(200)
  })

  it("answers before the legacy reset email settles", async () => {
    delete process.env.MESSAGING_NEW_SEND_PORTAL_FORGOT
    sendEmailMock.mockReturnValue(new Promise(() => undefined))
    const res = await POST(buildReq({ email: "user@example.com" }))
    expect(res.status).toBe(200)
    expect(sendEmailMock).toHaveBeenCalledTimes(1)
  })

  it("uses email when the client has no WhatsApp number", async () => {
    lenderRows.commsSettings = waCloud
    const res = await POST(buildReq({ email: "user@example.com", channel: "WHATSAPP" }))
    expect(res.status).toBe(200)
    expect(sendPortalOtpByWhatsApp).not.toHaveBeenCalled()
    expect(sendEmailMock).toHaveBeenCalledTimes(1)
  })
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
// so a demo deployment returns it to the request that issued it — but only
// when DEMO_MODE is exactly "true" AND the address is a `.invalid` one.
// Every return path after the OTP is issued is covered.
describe("POST /api/portal/forgot-password — DEMO_MODE reset code reveal", () => {
  const DEMO_EMAIL = "thabo.pillay@acme-lending.invalid"
  const REAL_EMAIL = "someone@example.com"

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  function issuedCode(): string {
    return (clientOtpCreateMock.mock.calls[0][0] as { data: { otp: string } }).data.otp
  }

  // [label, MESSAGING_NEW_SEND_PORTAL_FORGOT, arrange, proof the path ran]
  const RETURN_PATHS: Array<[string, string | undefined, () => void, () => void]> = [
    ["legacy send", undefined, () => {}, () => expect(sendEmailMock).toHaveBeenCalledTimes(1)],
    ["new send pipeline", "true", () => {}, () => expect(sendMessageMock).toHaveBeenCalledTimes(1)],
    [
      "new send, Contact missing", "true",
      () => lookupContactMock.mockResolvedValue(null),
      () => expect(messageTemplateFindFirstMock).not.toHaveBeenCalled(),
    ],
    [
      "new send, template missing", "true",
      () => messageTemplateFindFirstMock.mockResolvedValue(null),
      () => {
        expect(messageTemplateFindFirstMock).toHaveBeenCalledTimes(1)
        expect(sendMessageMock).not.toHaveBeenCalled()
      },
    ],
  ]

  async function post(path: (typeof RETURN_PATHS)[number], email: string, demoMode: string | undefined) {
    const [, newSend, arrange, ranPath] = path
    vi.stubEnv("DEMO_MODE", demoMode)
    vi.stubEnv("MESSAGING_NEW_SEND_PORTAL_FORGOT", newSend)
    arrange()
    clientFindFirstMock.mockResolvedValue({
      id: "cl_a", email, firstName: "Thabo", lastName: "P", tenantId: "tenant_acme",
    })
    const res = await POST(buildReq({ email }))
    expect(res.status).toBe(200)
    expect(clientOtpCreateMock).toHaveBeenCalledTimes(1)
    ranPath()
    return (await res.json()) as Record<string, unknown>
  }

  describe.each(RETURN_PATHS.map((p) => [p[0], p] as const))("%s", (_label, path) => {
    it("returns the issued code for a .invalid recipient when DEMO_MODE=true", async () => {
      const data = await post(path, DEMO_EMAIL, "true")
      expect(data.demoCode).toMatch(/^\d{6}$/)
      expect(data.demoCode).toBe(issuedCode())
    })

    it.each([undefined, "false", "TRUE "])("never returns the code when DEMO_MODE=%j", async (value) => {
      const data = await post(path, DEMO_EMAIL, value)
      expect(data).toEqual({ success: true })
    })

    it("never returns the code for a deliverable address, even when DEMO_MODE=true", async () => {
      const data = await post(path, REAL_EMAIL, "true")
      expect(data).toEqual({ success: true })
    })
  })

  it("returns no code for an unknown email, even in demo mode", async () => {
    vi.stubEnv("DEMO_MODE", "true")
    clientFindFirstMock.mockResolvedValue(null)
    const data = await (await POST(buildReq({ email: "nobody@acme-lending.invalid" }))).json()
    expect(data).toEqual({ success: true })
  })
})


it("does not dispatch any reset code when its transactional audit fails", async () => {
  auditCreateMock.mockRejectedValue(new Error("audit unavailable"))
  await expect(POST(buildReq({ email: "user@example.com", turnstileToken: "synthetic" }))).rejects.toThrow("audit unavailable")
  expect(sendEmailMock).not.toHaveBeenCalled()
  expect(sendMessageMock).not.toHaveBeenCalled()
  expect(sendPortalOtpByWhatsApp).not.toHaveBeenCalled()
})
