// app/api/portal/register/route.test.ts
//
// Covers the SIGN-01/SIGN-02 rework of portal registration into a two-mode,
// OTP-gated activation flow: (a) request-code mode always returns the same
// generic success and creates a ClientOtp only when a real un-activated
// client matches, with zero distinction for not-found/already-activated;
// (b) verify-activate mode with a valid OTP activates the account, marks
// the OTP used, and writes a CLIENT_UPDATED audit log; (c) an invalid or
// expired OTP is rejected with the same generic 400 used for every other
// failure case; (d) an already-activated client in verify mode gets the
// identical generic 400 (no 409 leak); (e) the pre-existing gates (Turnstile,
// per-IP cap, per-identity rate limit) still fire ahead of both modes.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { POST } from "./route"
import { NextRequest } from "next/server"

const {
  findFirstClient,
  updateClient,
  findFirstClientOtp,
  createClientOtp,
  updateClientOtp,
  updateManyClientOtp,
  sendEmail,
  logAudit,
  verifyTurnstile,
  checkRateLimit,
  callerIp,
  sendMessage,
  resolveMessagingTarget,
} = vi.hoisted(() => ({
  findFirstClient: vi.fn(),
  updateClient: vi.fn(),
  findFirstClientOtp: vi.fn(),
  createClientOtp: vi.fn(),
  updateClientOtp: vi.fn(),
  updateManyClientOtp: vi.fn(),
  sendEmail: vi.fn(),
  logAudit: vi.fn().mockResolvedValue(undefined),
  verifyTurnstile: vi.fn(),
  checkRateLimit: vi.fn(),
  callerIp: vi.fn(),
  sendMessage: vi.fn(),
  resolveMessagingTarget: vi.fn(),
}))

// TenantConfig / CommsSettings rows for the portal switches and the WhatsApp
// leg; null = no row = every default (portal and registration on, no WhatsApp Cloud).
const lenderRows = vi.hoisted(() => ({
  tenantConfig: null as null | Record<string, unknown>,
  commsSettings: null as null | Record<string, unknown>,
}))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    client: { findFirst: findFirstClient, update: updateClient },
    clientOtp: { findFirst: findFirstClientOtp, create: createClientOtp, update: updateClientOtp, updateMany: updateManyClientOtp },
    tenantConfig: { findUnique: async () => lenderRows.tenantConfig },
    commsSettings: { findUnique: async () => lenderRows.commsSettings },
  },
}))

vi.mock("@/lib/tenant", () => ({
  withTenantContext: (
    _req: unknown,
    fn: (t: { id: string }) => unknown
  ) => fn({ id: "tenant-1" }),
}))

vi.mock("@/lib/turnstile", () => ({ verifyTurnstile }))

vi.mock("@/lib/rate-limit", () => ({ checkRateLimit, callerIp }))

vi.mock("@/lib/config/identity", async () => {
  const { parseLenderIdentity } = await vi.importActual<typeof import("@/lib/config/identity")>("@/lib/config/identity")
  const { VALID_LENDER_COLUMNS } = await import("@/lib/config/__fixtures__/lender-identity")
  return { getLenderIdentity: async () => parseLenderIdentity(VALID_LENDER_COLUMNS) }
})
vi.mock("@/lib/email/service", () => ({ sendEmail }))

vi.mock("@/lib/messaging/send", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/messaging/send")>()),
  sendMessage,
}))
vi.mock("@/lib/messaging/route-delivery", () => ({ resolveMessagingTarget }))

vi.mock("@/lib/audit", () => ({
  logAudit,
  AuditAction: new Proxy({}, { get: (_t, k) => String(k) }),
}))

const sendPortalOtpByWhatsApp = vi.hoisted(() => vi.fn())
vi.mock("@/lib/portal/portal-otp-whatsapp", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/portal/portal-otp-whatsapp")>()),
  sendPortalOtpByWhatsApp,
}))

function makeRequest(body: Record<string, unknown>) {
  return new NextRequest("http://localhost/api/portal/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

const requestCodeBody = {
  email: "jane@example.com",
  idNumber: "9001016000082",
  turnstileToken: "solved-token",
}

const verifyBody = {
  email: "jane@example.com",
  idNumber: "9001016000082",
  otp: "654321",
  password: "correct-horse-1",
  confirmPassword: "correct-horse-1",
  turnstileToken: "solved-token",
}

const unactivatedClient = {
  id: "client-1",
  email: "jane@example.com",
  firstName: "Jane",
  lastName: "Doe",
  idNumber: "9001016000082",
  portalPassword: null,
}

const validOtpRecord = {
  id: "otp-1",
  email: "jane@example.com",
  otp: "654321",
  used: false,
  expiresAt: new Date(Date.now() + 10 * 60 * 1000),
}

beforeEach(() => {
  vi.clearAllMocks()
  verifyTurnstile.mockResolvedValue({ ok: true })
  callerIp.mockReturnValue("203.0.113.1")
  checkRateLimit.mockReturnValue({ allowed: true, remaining: 4, retryAfterSeconds: 0 })
  findFirstClient.mockResolvedValue(unactivatedClient)
  updateClient.mockResolvedValue({ ...unactivatedClient, portalPassword: "hashed" })
  findFirstClientOtp.mockResolvedValue(validOtpRecord)
  createClientOtp.mockResolvedValue({ ...validOtpRecord })
  updateClientOtp.mockResolvedValue({ ...validOtpRecord, used: true })
  updateManyClientOtp.mockResolvedValue({ count: 1 })
  sendEmail.mockResolvedValue({ ok: true })
  sendPortalOtpByWhatsApp.mockResolvedValue(undefined)
  lenderRows.tenantConfig = null
  lenderRows.commsSettings = null
})

afterEach(() => {
  vi.clearAllMocks()
})

describe("POST /api/portal/register — lender switches", () => {
  it("refuses every request with the portal-unavailable 404 while the portal is off", async () => {
    lenderRows.tenantConfig = { featurePortal: false, allowNewRegistrations: true }
    for (const body of [requestCodeBody, verifyBody]) {
      const res = await POST(makeRequest(body))
      expect(res.status).toBe(404)
      expect(await res.json()).toEqual(expect.objectContaining({ portal: "disabled" }))
    }
    expect(findFirstClient).not.toHaveBeenCalled()
    expect(createClientOtp).not.toHaveBeenCalled()
  })

  it("refuses new activations while registrations are closed, in both modes, before any lookup", async () => {
    lenderRows.tenantConfig = { featurePortal: true, allowNewRegistrations: false }
    for (const body of [requestCodeBody, verifyBody]) {
      const res = await POST(makeRequest(body))
      expect(res.status).toBe(403)
      expect(await res.json()).toEqual(expect.objectContaining({ portal: "registrations_closed" }))
    }
    expect(findFirstClient).not.toHaveBeenCalled()
    expect(findFirstClientOtp).not.toHaveBeenCalled()
    expect(updateClient).not.toHaveBeenCalled()
  })
})

describe("POST /api/portal/register — WhatsApp as the code channel", () => {
  const waCloud = { whatsappEnabled: true, waProvider: "WA_CLOUD", wabaPhoneNumberId: "pn-1", wabaAccessToken: "token" }
  const withWhatsapp = { ...unactivatedClient, whatsapp: "0820000001" }
  const WA_MESSAGE = /WhatsApp number on file, or by email/

  it("sends the code on WhatsApp, not email, when the lender runs WhatsApp Cloud and the client has a number", async () => {
    lenderRows.commsSettings = waCloud
    findFirstClient.mockResolvedValue(withWhatsapp)
    const data = await (await POST(makeRequest({ ...requestCodeBody, channel: "WHATSAPP" }))).json()

    expect(data.message).toMatch(WA_MESSAGE)
    await vi.waitFor(() => expect(sendPortalOtpByWhatsApp).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: "tenant-1", purpose: "activation", otpRecordId: "otp-1", code: expect.stringMatching(/^\d{6}$/),
    })))
    await new Promise((resolve) => setImmediate(resolve))
    expect(sendEmail).not.toHaveBeenCalled()
  })

  it("falls back to email when the client has no WhatsApp number, with the same answer", async () => {
    lenderRows.commsSettings = waCloud
    const data = await (await POST(makeRequest({ ...requestCodeBody, channel: "WHATSAPP" }))).json()

    expect(data.message).toMatch(WA_MESSAGE)
    await vi.waitFor(() => expect(sendEmail).toHaveBeenCalledTimes(1))
    expect(sendPortalOtpByWhatsApp).not.toHaveBeenCalled()
  })

  it("falls back to email when the lender has no WhatsApp Cloud (never SMS)", async () => {
    findFirstClient.mockResolvedValue(withWhatsapp)
    await POST(makeRequest({ ...requestCodeBody, channel: "WHATSAPP" }))

    await vi.waitFor(() => expect(sendEmail).toHaveBeenCalledTimes(1))
    expect(sendPortalOtpByWhatsApp).not.toHaveBeenCalled()
  })

  it("answers an unmatched WhatsApp request identically", async () => {
    lenderRows.commsSettings = waCloud
    findFirstClient.mockResolvedValue(null)
    const unmatched = await (await POST(makeRequest({ ...requestCodeBody, channel: "WHATSAPP" }))).json()
    findFirstClient.mockResolvedValue(withWhatsapp)
    const matched = await (await POST(makeRequest({ ...requestCodeBody, channel: "WHATSAPP" }))).json()
    expect(unmatched).toEqual(matched)
  })
})

describe("POST /api/portal/register — request-code mode (SIGN-02 enumeration safety)", () => {
  it("returns the generic success and creates a ClientOtp when a matching un-activated client exists", async () => {
    const res = await POST(makeRequest(requestCodeBody))
    const data = await res.json()

    expect(res.status).toBe(200)
    expect(data.success).toBe(true)
    expect(data.message).toMatch(/activation code/i)

    expect(findFirstClient).toHaveBeenCalledWith({
      where: {
        email: "jane@example.com",
        idNumber: "9001016000082",
        tenantId: "tenant-1",
        portalPassword: null,
        // Never a dealer-captured client whose contact details staff have not verified.
        OR: [{ createdByDealerId: null }, { dealerContactVerifiedAt: { not: null } }],
      },
    })
    expect(createClientOtp).toHaveBeenCalledTimes(1)
    expect(createClientOtp).toHaveBeenCalledWith({
      data: expect.objectContaining({ email: "jane@example.com", otp: expect.any(String) }),
    })
    // The legacy send is detached (timing-safe) and now reads the identity first.
    await vi.waitFor(() => expect(sendEmail).toHaveBeenCalledTimes(1))
  })

  it("returns the IDENTICAL generic success when no client matches (no 404 leak)", async () => {
    findFirstClient.mockResolvedValue(null)

    const res = await POST(makeRequest(requestCodeBody))
    const data = await res.json()

    expect(res.status).toBe(200)
    expect(data).toEqual({
      success: true,
      message:
        "If those details match an application, we've emailed a 6-digit activation code. Enter it below to finish.",
    })
    expect(createClientOtp).not.toHaveBeenCalled()
    expect(sendEmail).not.toHaveBeenCalled()
  })

  it("returns the IDENTICAL generic success when the client is already activated (no 409 leak)", async () => {
    // The DB query itself filters portalPassword: null, so an already-active
    // client simply doesn't match — same as not-found from the caller's view.
    findFirstClient.mockResolvedValue(null)

    const res = await POST(makeRequest(requestCodeBody))
    const data = await res.json()

    expect(res.status).toBe(200)
    expect(data).toEqual({
      success: true,
      message:
        "If those details match an application, we've emailed a 6-digit activation code. Enter it below to finish.",
    })
    expect(createClientOtp).not.toHaveBeenCalled()
    expect(sendEmail).not.toHaveBeenCalled()
  })
})

describe("POST /api/portal/register — verify-activate mode", () => {
  it("activates the account, marks the OTP used, and writes a CLIENT_UPDATED audit log", async () => {
    const res = await POST(makeRequest(verifyBody))
    const data = await res.json()

    expect(res.status).toBe(200)
    expect(data).toEqual({ success: true, message: "Account activated. Please log in." })

    expect(updateClient).toHaveBeenCalledWith({
      where: { id: "client-1" },
      data: { portalPassword: expect.any(String) },
    })
    expect(updateManyClientOtp).toHaveBeenCalledWith({
      where: { id: "otp-1", used: false },
      data: { used: true },
    })

    expect(logAudit).toHaveBeenCalledTimes(1)
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: "tenant-1",
        action: "CLIENT_UPDATED",
        entity: "Client",
        entityId: "client-1",
        ipAddress: "203.0.113.1",
        newValue: expect.objectContaining({ event: "portal_account_activated" }),
      })
    )
  })

  it("rejects an invalid/expired OTP with the generic 400 and never activates", async () => {
    findFirstClientOtp.mockResolvedValue(null)

    const res = await POST(makeRequest(verifyBody))
    const data = await res.json()

    expect(res.status).toBe(400)
    expect(data).toEqual({ error: "Invalid or expired code." })
    expect(updateClient).not.toHaveBeenCalled()
    expect(updateManyClientOtp).not.toHaveBeenCalled()
    expect(logAudit).not.toHaveBeenCalled()
  })

  it("rejects a mismatched OTP code with the same generic 400", async () => {
    findFirstClientOtp.mockResolvedValue({ ...validOtpRecord, otp: "111111" })

    const res = await POST(makeRequest(verifyBody))
    const data = await res.json()

    expect(res.status).toBe(400)
    expect(data).toEqual({ error: "Invalid or expired code." })
    expect(updateClient).not.toHaveBeenCalled()
  })

  it("rejects an already-activated client with the SAME generic 400 (no 409 leak)", async () => {
    findFirstClient.mockResolvedValue({ ...unactivatedClient, portalPassword: "already-set" })

    const res = await POST(makeRequest(verifyBody))
    const data = await res.json()

    expect(res.status).toBe(400)
    expect(data).toEqual({ error: "Invalid or expired code." })
    expect(updateClient).not.toHaveBeenCalled()
    expect(updateManyClientOtp).not.toHaveBeenCalled()
    expect(logAudit).not.toHaveBeenCalled()
  })

  it("rejects a no-matching-client case with the SAME generic 400 (no 404 leak)", async () => {
    findFirstClient.mockResolvedValue(null)

    const res = await POST(makeRequest(verifyBody))
    const data = await res.json()

    expect(res.status).toBe(400)
    expect(data).toEqual({ error: "Invalid or expired code." })
    expect(updateClient).not.toHaveBeenCalled()
    expect(logAudit).not.toHaveBeenCalled()
  })

  it("rejects a too-short password before ever touching the OTP/client tables", async () => {
    const res = await POST(makeRequest({ ...verifyBody, password: "short", confirmPassword: "short" }))
    const data = await res.json()

    expect(res.status).toBe(400)
    expect(data.error).toMatch(/at least 10 characters/i)
    expect(findFirstClientOtp).not.toHaveBeenCalled()
  })

  // Fair Score audit 2026-10-16: activation accepted "password".
  it.each(["password", "password1234", "Qwerty12345!"])("refuses the common password %s before touching the OTP/client tables", async (password) => {
    const res = await POST(makeRequest({ ...verifyBody, password, confirmPassword: password }))

    expect(res.status).toBe(400)
    expect(findFirstClientOtp).not.toHaveBeenCalled()
    expect(updateClient).not.toHaveBeenCalled()
  })

  it("rejects mismatched password/confirmPassword", async () => {
    const res = await POST(makeRequest({ ...verifyBody, confirmPassword: "different-1234" }))
    const data = await res.json()

    expect(res.status).toBe(400)
    expect(data.error).toMatch(/do not match/i)
    expect(findFirstClientOtp).not.toHaveBeenCalled()
  })
})

describe("POST /api/portal/register — preserved gates (SIGN-04/04b/07)", () => {
  it("rejects a missing/invalid Turnstile token before touching the database, in either mode", async () => {
    verifyTurnstile.mockResolvedValue({ ok: false, errorCodes: ["missing-token"] })

    const res = await POST(makeRequest({ ...requestCodeBody, turnstileToken: undefined }))
    const data = await res.json()

    expect(res.status).toBe(400)
    expect(data.error).toMatch(/verification failed/i)
    expect(findFirstClient).not.toHaveBeenCalled()
    expect(createClientOtp).not.toHaveBeenCalled()
  })

  it("blocks a same-IP flood BEFORE verifyTurnstile, bounding Cloudflare-verify calls", async () => {
    const hitsByKey = new Map<string, number>()
    checkRateLimit.mockImplementation((key: string, opts: { limit: number }) => {
      const count = (hitsByKey.get(key) ?? 0) + 1
      hitsByKey.set(key, count)
      return {
        allowed: count <= opts.limit,
        remaining: Math.max(0, opts.limit - count),
        retryAfterSeconds: count <= opts.limit ? 0 : 900,
      }
    })
    callerIp.mockReturnValue("203.0.113.99") // SAME IP every request


    let lastRes: Response | undefined
    for (let i = 0; i < 31; i++) {
      lastRes = await POST(makeRequest(requestCodeBody))
    }

    expect(lastRes!.status).toBe(429)
    expect(verifyTurnstile).toHaveBeenCalledTimes(30)
  })

  it("blocks a second request-code attempt against the same email+ID even from a different IP", async () => {
    const hitsByKey = new Map<string, number>()
    checkRateLimit.mockImplementation((key: string, opts: { limit: number }) => {
      const count = (hitsByKey.get(key) ?? 0) + 1
      hitsByKey.set(key, count)
      return {
        allowed: count <= opts.limit,
        remaining: Math.max(0, opts.limit - count),
        retryAfterSeconds: count <= opts.limit ? 0 : 900,
      }
    })


    let lastRes: Response | undefined
    for (let i = 0; i < 6; i++) {
      callerIp.mockReturnValue(`203.0.113.${i}`) // different IP every call
      lastRes = await POST(makeRequest(requestCodeBody))
    }

    expect(lastRes!.status).toBe(429)
    const data = await lastRes!.json()
    expect(data.error).toMatch(/too many requests/i)

    // 5 identity-gate keys allowed through to the DB, the 6th was blocked
    // before ever reaching prisma — proving the block is per-identity, not
    // per-IP (every call used a distinct IP).
    expect(createClientOtp).toHaveBeenCalledTimes(5)

    const identityKeyCalls = checkRateLimit.mock.calls.filter(
      ([key]) => key === "register:jane@example.com"
    )
    expect(identityKeyCalls).toHaveLength(6)
  })

  it("normalizes email case + whitespace so variants collapse to one identity bucket", async () => {
    const keys: string[] = []
    checkRateLimit.mockImplementation((key: string) => {
      keys.push(key)
      return { allowed: true, remaining: 4, retryAfterSeconds: 0 }
    })

    await POST(makeRequest({ ...requestCodeBody, email: "  JANE@Example.COM " }))

    // The identity-gate key is lower-cased + trimmed identically to the DB
    // client lookup, so "  JANE@Example.COM " cannot dodge the throttle by
    // varying case/whitespace against the same account.
    expect(keys).toContain("register:jane@example.com")
  })
})

describe("POST /api/portal/register — MESSAGING_NEW_SEND_PORTAL_ACTIVATION", () => {
  beforeEach(() => {
    process.env.MESSAGING_NEW_SEND_PORTAL_ACTIVATION = "true"
    resolveMessagingTarget.mockResolvedValue({
      ok: true,
      contact: { id: "contact-1" },
      template: { id: "tpl-activation", tenantId: "tenant-1" },
    })
    sendMessage.mockResolvedValue({ id: "msg-1" })
  })

  afterEach(() => {
    delete process.env.MESSAGING_NEW_SEND_PORTAL_ACTIVATION
  })

  it("routes the activation code through sendMessage() so it lands on the comms timeline", async () => {
    const res = await POST(makeRequest(requestCodeBody))
    expect(res.status).toBe(200)

    // Fire-and-forget: let the detached chain settle before asserting.
    await new Promise((resolve) => setImmediate(resolve))

    expect(sendEmail).not.toHaveBeenCalled()
    expect(resolveMessagingTarget).toHaveBeenCalledWith(expect.objectContaining({
      channel: "EMAIL",
      value: "jane@example.com",
      templateKey: "portal_activation_email",
    }))
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      contactId: "contact-1",
      channel: "EMAIL",
      category: "portal-otp",
      idempotencyKey: "portal-activation:otp-1:EMAIL",
      vars: expect.objectContaining({ otp: expect.any(String) }),
    }))
  })

  it("returns BEFORE the send settles — response timing must not leak client existence", async () => {
    // A matched request that awaited the Contact lookup, the template lookup
    // or the send would be measurably slower than a no-match (which returns
    // immediately). Model that by never resolving the lookup: if any of it
    // were awaited on the request path, this POST would hang.
    resolveMessagingTarget.mockReturnValue(new Promise(() => {}))

    const res = await Promise.race([
      POST(makeRequest(requestCodeBody)),
      new Promise((_, reject) => setTimeout(() => reject(new Error("POST awaited the send")), 500)),
    ]) as Response

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(expect.objectContaining({ success: true }))
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it("writes a durable audit row when eligibility blocks the activation code", async () => {
    // The consumer is told nothing (enumeration safety) and no code ever
    // arrives. Without this record the failure is invisible to support too.
    const { SendBlockedError } = await import("@/lib/messaging/send")
    sendMessage.mockRejectedValue(new SendBlockedError("CHANNEL_OPTED_OUT"))

    const res = await POST(makeRequest(requestCodeBody))
    expect(res.status).toBe(200)
    await new Promise((resolve) => setImmediate(resolve))

    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: "MESSAGE_SEND_BLOCKED_BY_ELIGIBILITY",
      newValue: expect.objectContaining({
        reason: "CHANNEL_OPTED_OUT",
        templateKey: "portal_activation_email",
        consumerToldNothing: true,
      }),
    }))
  })

  it("audits a non-eligibility send failure too — the staging UNSUB_TOKEN_SECRET case", async () => {
    // assertRedactedSendIsRecoverable throws exactly here wherever
    // UNSUB_TOKEN_SECRET is unset (a walkthrough environment). Nobody awaits the
    // detached promise, so without a row the consumer gets success:true, no
    // code, and no trace anywhere.
    sendMessage.mockRejectedValue(new Error("Refusing to send redacted template: UNSUB_TOKEN_SECRET is not set"))
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {})

    const res = await POST(makeRequest(requestCodeBody))
    expect(res.status).toBe(200)
    await new Promise((resolve) => setImmediate(resolve))

    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: "MESSAGE_SEND_FAILED_UNDELIVERED",
      newValue: expect.objectContaining({
        failure: expect.stringMatching(/UNSUB_TOKEN_SECRET/),
        consumerToldNothing: true,
      }),
    }))
    errorLog.mockRestore()
  })

  it("does not send — and does not throw — when the Contact row is missing", async () => {
    resolveMessagingTarget.mockResolvedValue({ ok: false, reason: "no Contact row for this email address" })
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})

    const res = await POST(makeRequest(requestCodeBody))
    expect(res.status).toBe(200)
    await new Promise((resolve) => setImmediate(resolve))

    expect(sendMessage).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})

// DEMO_MODE: the activation code goes to a fictional address and never
// arrives, so a demo deployment returns it to the request that issued it —
// but only when DEMO_MODE is exactly "true" AND the address is a `.invalid`
// one. Both return paths that issue a code are covered.
describe("POST /api/portal/register — DEMO_MODE activation code reveal", () => {
  const DEMO_EMAIL = "thabo.pillay@acme-lending.invalid"
  const REAL_EMAIL = "someone@example.com"

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  function issuedCode(): string {
    return (createClientOtp.mock.calls[0][0] as { data: { otp: string } }).data.otp
  }

  // [label, MESSAGING_NEW_SEND_PORTAL_ACTIVATION, proof the path ran]
  const RETURN_PATHS: Array<[string, string | undefined, () => void]> = [
    ["legacy send", undefined, () => expect(sendEmail).toHaveBeenCalledTimes(1)],
    ["new send pipeline", "true", () => expect(resolveMessagingTarget).toHaveBeenCalledTimes(1)],
  ]

  async function post(path: (typeof RETURN_PATHS)[number], email: string, demoMode: string | undefined) {
    const [, newSend, ranPath] = path
    vi.stubEnv("DEMO_MODE", demoMode)
    vi.stubEnv("MESSAGING_NEW_SEND_PORTAL_ACTIVATION", newSend)
    resolveMessagingTarget.mockResolvedValue({ ok: false, reason: "test" })
    vi.spyOn(console, "warn").mockImplementation(() => {})
    findFirstClient.mockResolvedValue({ ...unactivatedClient, email })
    const { POST } = await import("./route")
    const res = await POST(makeRequest({ ...requestCodeBody, email }))
    expect(res.status).toBe(200)
    expect(createClientOtp).toHaveBeenCalledTimes(1)
    // The sends are detached from the response; let them start.
    await new Promise((resolve) => setImmediate(resolve))
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
      expect(data).not.toHaveProperty("demoCode")
      expect(JSON.stringify(data)).not.toContain(issuedCode())
    })

    it("never returns the code for a deliverable address, even when DEMO_MODE=true", async () => {
      const data = await post(path, REAL_EMAIL, "true")
      expect(data).not.toHaveProperty("demoCode")
      expect(JSON.stringify(data)).not.toContain(issuedCode())
    })
  })

  it("issues and returns nothing when no client matches, even in demo mode", async () => {
    vi.stubEnv("DEMO_MODE", "true")
    findFirstClient.mockResolvedValue(null)
    const { POST } = await import("./route")
    const data = await (await POST(makeRequest({ ...requestCodeBody, email: DEMO_EMAIL }))).json()
    expect(data).not.toHaveProperty("demoCode")
    expect(createClientOtp).not.toHaveBeenCalled()
  })
})
