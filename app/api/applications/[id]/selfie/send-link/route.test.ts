import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const {
  requireApiRole,
  applicationFindUnique,
  tokenUpdateMany,
  transaction,
  mintSelfieLinkToken,
  sendSms,
  sendWhatsApp,
  sendEmail,
  logAudit,
} = vi.hoisted(() => ({
  requireApiRole: vi.fn(),
  applicationFindUnique: vi.fn(),
  tokenUpdateMany: vi.fn(),
  transaction: vi.fn(),
  mintSelfieLinkToken: vi.fn(),
  sendSms: vi.fn(),
  sendWhatsApp: vi.fn(),
  sendEmail: vi.fn(),
  logAudit: vi.fn(),
}))

vi.mock("@/lib/config/identity", async () => {
  const { parseLenderIdentity } = await vi.importActual<typeof import("@/lib/config/identity")>("@/lib/config/identity")
  const { VALID_LENDER_COLUMNS } = await import("@/lib/config/__fixtures__/lender-identity")
  return { getLenderIdentity: async () => parseLenderIdentity(VALID_LENDER_COLUMNS) }
})
vi.mock("@/lib/auth-guards", () => ({ requireApiRole }))
vi.mock("@/lib/tenant", () => ({
  withTenantContext: (_req: unknown, callback: (tenant: { id: string }) => unknown) =>
    callback({ id: "tenant-1" }),
}))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    loanApplication: { findUnique: applicationFindUnique },
    selfieCaptureToken: { updateMany: tokenUpdateMany },
    $transaction: (...args: unknown[]) => transaction(...args),
  },
}))
vi.mock("@/lib/kyc/selfie-link-token.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/kyc/selfie-link-token.server")>()),
  mintSelfieLinkToken: (...args: unknown[]) => mintSelfieLinkToken(...args),
}))
vi.mock("@/lib/integrations/bulksms", () => ({
  sendSms: (...args: unknown[]) => sendSms(...args),
  sendWhatsApp: (...args: unknown[]) => sendWhatsApp(...args),
}))
vi.mock("@/lib/email/service", () => ({ sendEmail: (...args: unknown[]) => sendEmail(...args) }))
vi.mock("@/lib/audit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/audit")>()),
  logAudit: (...args: unknown[]) => logAudit(...args),
}))

import { POST } from "./route"

const SECRET = "s".repeat(43)
const CLIENT = {
  firstName: "Thabo",
  lastName: "Mokoena",
  email: "thabo@example.test",
  phone: "+27820000000",
  whatsapp: "+27831111111",
}

function post(body: unknown): NextRequest {
  return new NextRequest("http://x/api/applications/app1/selfie/send-link", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
}
const params = { params: Promise.resolve({ id: "app1" }) }

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv("NEXT_PUBLIC_PORTAL_URL", "https://portal.lender.example")
  vi.stubEnv("NEXTAUTH_URL", "https://app.lender.example")
  requireApiRole.mockResolvedValue({ user: { id: "u1", email: "officer@acme-lending.example" } })
  applicationFindUnique.mockResolvedValue({
    id: "app1",
    clientId: "c1",
    status: "UNDER_REVIEW",
    client: CLIENT,
  })
  mintSelfieLinkToken.mockResolvedValue({
    id: "tok1",
    secret: SECRET,
    tokenHash: "h",
    expiresAt: new Date("2026-08-07T10:00:00.000Z"),
  })
  transaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
    fn({ selfieCaptureToken: {} }),
  )
  sendSms.mockResolvedValue({ ok: true })
  sendWhatsApp.mockResolvedValue({ ok: true })
  sendEmail.mockResolvedValue({ ok: true })
})

describe("POST /api/applications/[id]/selfie/send-link", () => {
  it("is gated at CREDIT_OFFICER, the same floor as the PASQ link", async () => {
    await POST(post({ channel: "SMS" }), params)
    expect(requireApiRole).toHaveBeenCalledWith("CREDIT_OFFICER")
  })

  it("returns the guard's own refusal when the caller is not permitted", async () => {
    const { NextResponse } = await import("next/server")
    requireApiRole.mockResolvedValue({
      error: NextResponse.json({ error: "Forbidden" }, { status: 403 }),
    })

    const res = await POST(post({ channel: "SMS" }), params)

    expect(res.status).toBe(403)
    expect(mintSelfieLinkToken).not.toHaveBeenCalled()
    expect(sendSms).not.toHaveBeenCalled()
  })

  // A deployment with BULKSMS_DRY_RUN=true sends nothing. Without this guard the route dispatched,
  // got a `simulated` result, and audited a capture link the consumer never
  // received.
  describe("SMS channel off (BULKSMS_DRY_RUN=true)", () => {
    afterEach(() => {
      process.env.BULKSMS_DRY_RUN = "false"
    })

    it("refuses an SMS send with 400 and dispatches nothing", async () => {
      process.env.BULKSMS_DRY_RUN = "true"

      const res = await POST(post({ channel: "SMS" }), params)

      expect(res.status).toBe(400)
      expect((await res.json()).error).toContain("SMS not enabled")
      expect(sendSms).not.toHaveBeenCalled()
      expect(mintSelfieLinkToken).not.toHaveBeenCalled()
    })

    it("leaves the WhatsApp channel working", async () => {
      process.env.BULKSMS_DRY_RUN = "true"

      const res = await POST(post({ channel: "WHATSAPP" }), params)

      expect(res.status).toBe(200)
      expect(sendWhatsApp).toHaveBeenCalledOnce()
    })

    it("CHANNEL ON: SMS still sends", async () => {
      process.env.BULKSMS_DRY_RUN = "false"

      const res = await POST(post({ channel: "SMS" }), params)

      expect(res.status).toBe(200)
      expect(sendSms).toHaveBeenCalledOnce()
    })
  })

  it("rejects a channel that is not SMS, WHATSAPP or EMAIL", async () => {
    const res = await POST(post({ channel: "TELEGRAM" }), params)

    expect(res.status).toBe(400)
    expect(mintSelfieLinkToken).not.toHaveBeenCalled()
    expect(sendWhatsApp).not.toHaveBeenCalled()
    expect(sendSms).not.toHaveBeenCalled()
  })

  it("ignores a destination supplied by the caller and uses the record on file", async () => {
    // THE control that makes a bearer token acceptable. A staff member who can
    // choose the destination can send themselves the consumer's link and
    // manufacture the evidence.
    await POST(post({ channel: "WHATSAPP", to: "+27829999999" }), params)

    expect(sendWhatsApp).toHaveBeenCalledWith(
      expect.objectContaining({ to: CLIENT.whatsapp }),
    )
    expect(JSON.stringify(sendWhatsApp.mock.calls[0][0])).not.toContain("+27829999999")
  })

  it("falls back to the phone on file when the client has no WhatsApp number", async () => {
    applicationFindUnique.mockResolvedValue({
      id: "app1",
      clientId: "c1",
      status: "UNDER_REVIEW",
      client: { ...CLIENT, whatsapp: null },
    })

    await POST(post({ channel: "WHATSAPP" }), params)

    expect(sendWhatsApp).toHaveBeenCalledWith(expect.objectContaining({ to: CLIENT.phone }))
  })

  it("refuses with 422 when the client record has no valid number for the channel", async () => {
    applicationFindUnique.mockResolvedValue({
      id: "app1",
      clientId: "c1",
      status: "UNDER_REVIEW",
      client: { ...CLIENT, whatsapp: null, phone: "" },
    })

    const res = await POST(post({ channel: "WHATSAPP" }), params)

    expect(res.status).toBe(422)
    expect(await res.json()).toEqual({
      error:
        "The client record has no valid E.164 number for this channel. Correct the client's contact details first — the capture link is only ever sent to the number on file.",
    })
    expect(mintSelfieLinkToken).not.toHaveBeenCalled()
  })

  it("refuses with 422 when the client record has no valid email", async () => {
    applicationFindUnique.mockResolvedValue({
      id: "app1",
      clientId: "c1",
      status: "UNDER_REVIEW",
      client: { ...CLIENT, email: "not-an-email" },
    })

    const res = await POST(post({ channel: "EMAIL" }), params)

    expect(res.status).toBe(422)
    expect(mintSelfieLinkToken).not.toHaveBeenCalled()
  })

  it("refuses once the application has left a capturable status", async () => {
    applicationFindUnique.mockResolvedValue({
      id: "app1",
      clientId: "c1",
      status: "DISBURSED",
      client: CLIENT,
    })

    const res = await POST(post({ channel: "SMS" }), params)

    expect(res.status).toBe(409)
    expect(mintSelfieLinkToken).not.toHaveBeenCalled()
  })

  it("404s an application that is not this tenant's", async () => {
    applicationFindUnique.mockResolvedValue(null)

    const res = await POST(post({ channel: "SMS" }), params)

    expect(res.status).toBe(404)
    expect(mintSelfieLinkToken).not.toHaveBeenCalled()
  })

  it("sends the capture URL built from the minted secret, and masks the audit destination", async () => {
    await POST(post({ channel: "SMS" }), params)

    expect(sendSms).toHaveBeenCalledWith(
      expect.objectContaining({
        to: CLIENT.phone,
        message: expect.stringContaining(`/selfie/${SECRET}`),
      }),
    )
    const audited = JSON.stringify(logAudit.mock.calls.at(-1)?.[0] ?? {})
    expect(audited).toContain("********0000")
    expect(audited).not.toContain(CLIENT.phone)
    // The URL secret is never logged: an audit reader must not be able to
    // capture on the consumer's behalf.
    expect(audited).not.toContain(SECRET)
  })

  it("invalidates the token when delivery did not positively succeed", async () => {
    // An unconfirmed live credential against a KYC act is cancelled even when
    // the provider verdict is ambiguous — the consumer simply asks for a fresh
    // link. Copied from the PASQ route, which the plan omitted.
    sendSms.mockResolvedValue({ ok: false, error: "gateway timeout" })

    const res = await POST(post({ channel: "SMS" }), params)

    expect(res.status).toBe(502)
    expect(tokenUpdateMany).toHaveBeenCalledWith({
      where: { id: "tok1", tenantId: "tenant-1", usedAt: null, invalidatedAt: null },
      data: { invalidatedAt: expect.any(Date) },
    })
  })

  it("leaves the token live when delivery succeeded", async () => {
    await POST(post({ channel: "SMS" }), params)

    expect(tokenUpdateMany).not.toHaveBeenCalled()
  })

  it("translates a concurrent mint into 409 rather than two live links", async () => {
    transaction.mockRejectedValue(Object.assign(new Error("unique"), { code: "P2002" }))

    const res = await POST(post({ channel: "SMS" }), params)

    expect(res.status).toBe(409)
  })

  it("never returns the secret to the caller", async () => {
    const res = await POST(post({ channel: "WHATSAPP" }), params)
    const body = JSON.stringify(await res.json())

    expect(body).not.toContain(SECRET)
    expect(body).toContain("********1111")
  })

  it("sends an email carrying the link, not the photo request as an attachment", async () => {
    await POST(post({ channel: "EMAIL" }), params)

    expect(sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: CLIENT.email,
        category: "selfie-link",
        referenceId: "app1",
      }),
    )
    expect(sendEmail.mock.calls[0][0]).not.toHaveProperty("attachments")
  })
})
