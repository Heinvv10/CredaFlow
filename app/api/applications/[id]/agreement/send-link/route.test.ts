import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const {
  requireApiRole,
  applicationFindUnique,
  sendSms,
  sendWhatsApp,
  sendEmail,
  logAudit,
} = vi.hoisted(() => ({
  requireApiRole: vi.fn(),
  applicationFindUnique: vi.fn(),
  sendSms: vi.fn(),
  sendWhatsApp: vi.fn(),
  sendEmail: vi.fn(),
  logAudit: vi.fn(),
}))

// The key-facts redirect reads the application by its own query; these routes are exercised as PASQ applications.
vi.mock("@/lib/non-nca-documents/refusal", () => ({ keyFactsRefusal: async () => null }))
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
  prisma: { loanApplication: { findUnique: applicationFindUnique } },
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

const CLIENT = {
  firstName: "Thabo",
  lastName: "Mokoena",
  email: "thabo@example.test",
  phone: "+27820000000",
  whatsapp: "+27831111111",
}

const READY_TO_SIGN = {
  id: "app1",
  reference: "APP-2026-0001",
  agreementGeneratedAt: new Date("2026-08-06T09:00:00.000Z"),
  agreementSignedAt: null,
  client: CLIENT,
}

function post(body: unknown): NextRequest {
  return new NextRequest("http://x/api/applications/app1/agreement/send-link", {
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
  applicationFindUnique.mockResolvedValue(READY_TO_SIGN)
  sendSms.mockResolvedValue({ ok: true })
  sendWhatsApp.mockResolvedValue({ ok: true })
  sendEmail.mockResolvedValue({ ok: true })
})

describe("POST /api/applications/[id]/agreement/send-link", () => {
  it("sends a continue link carrying the agreement destination, not a bearer token", async () => {
    const res = await POST(post({ channel: "WHATSAPP" }), params)

    expect(res.status).toBe(200)
    const message = sendWhatsApp.mock.calls[0][0].message as string
    expect(message).toContain("/portal/continue")
    expect(message).toContain(encodeURIComponent("/portal/agreement/app1"))
    // No bearer credential: a 43-char base64url run would be a secret.
    expect(message).not.toMatch(/[A-Za-z0-9_-]{43}/)
  })

  it("routes through the client host, never the staff origin", async () => {
    await POST(post({ channel: "WHATSAPP" }), params)

    const message = sendWhatsApp.mock.calls[0][0].message as string
    expect(message).not.toContain("app.lender.example")
  })

  // A deployment with BULKSMS_DRY_RUN=true sends nothing. Without this guard the route dispatched,
  // got a `simulated` result, and audited a signing link the consumer never
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

  it("refuses when the agreement has not been generated yet", async () => {
    applicationFindUnique.mockResolvedValue({ ...READY_TO_SIGN, agreementGeneratedAt: null })

    const res = await POST(post({ channel: "SMS" }), params)

    expect(res.status).toBe(409)
    expect(sendSms).not.toHaveBeenCalled()
  })

  it("refuses when the consumer has already signed", async () => {
    applicationFindUnique.mockResolvedValue({
      ...READY_TO_SIGN,
      agreementSignedAt: new Date("2026-08-06T10:00:00.000Z"),
    })

    const res = await POST(post({ channel: "SMS" }), params)

    expect(res.status).toBe(409)
    expect(sendSms).not.toHaveBeenCalled()
  })

  it("is gated at CREDIT_OFFICER, matching the other agreement delivery routes", async () => {
    await POST(post({ channel: "SMS" }), params)
    expect(requireApiRole).toHaveBeenCalledWith("CREDIT_OFFICER")
  })

  it("rejects a channel that is not SMS, WHATSAPP or EMAIL", async () => {
    const res = await POST(post({ channel: "PIGEON" }), params)

    expect(res.status).toBe(400)
    expect(sendSms).not.toHaveBeenCalled()
    expect(sendWhatsApp).not.toHaveBeenCalled()
    expect(sendEmail).not.toHaveBeenCalled()
  })

  it("ignores a destination supplied by the caller and uses the record on file", async () => {
    await POST(post({ channel: "WHATSAPP", to: "+27829999999" }), params)

    expect(sendWhatsApp).toHaveBeenCalledWith(expect.objectContaining({ to: CLIENT.whatsapp }))
    expect(JSON.stringify(sendWhatsApp.mock.calls[0][0])).not.toContain("+27829999999")
  })

  it("refuses with 422 when the client record has no valid number for the channel", async () => {
    applicationFindUnique.mockResolvedValue({
      ...READY_TO_SIGN,
      client: { ...CLIENT, whatsapp: null, phone: "" },
    })

    const res = await POST(post({ channel: "WHATSAPP" }), params)

    expect(res.status).toBe(422)
    expect(sendWhatsApp).not.toHaveBeenCalled()
  })

  it("404s an application that is not this tenant's", async () => {
    applicationFindUnique.mockResolvedValue(null)

    const res = await POST(post({ channel: "SMS" }), params)

    expect(res.status).toBe(404)
  })

  it("audits the send with a masked destination and no raw contact detail", async () => {
    await POST(post({ channel: "SMS" }), params)

    const audited = JSON.stringify(logAudit.mock.calls.at(-1)?.[0] ?? {})
    expect(audited).toContain("********0000")
    expect(audited).not.toContain(CLIENT.phone)
    expect(audited).toContain("app1")
  })

  it("reports a failed send as 502 rather than claiming success", async () => {
    sendSms.mockResolvedValue({ ok: false, error: "gateway timeout" })

    const res = await POST(post({ channel: "SMS" }), params)

    expect(res.status).toBe(502)
  })
})
