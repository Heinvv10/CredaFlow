import { createHash } from "node:crypto"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const {
  requireApiRole,
  applicationFindUnique,
  tokenUpdateMany,
  transaction,
  mintPasqLinkToken,
  sendSms,
  sendWhatsApp,
  sendEmail,
  readFile,
  documentFindUnique,
  accessLogCreate,
  logAudit,
  deliverViaMessaging,
  resolveMessagingTarget,
} = vi.hoisted(() => ({
  requireApiRole: vi.fn(),
  applicationFindUnique: vi.fn(),
  tokenUpdateMany: vi.fn(),
  transaction: vi.fn(),
  mintPasqLinkToken: vi.fn(),
  sendSms: vi.fn(),
  sendWhatsApp: vi.fn(),
  sendEmail: vi.fn(),
  readFile: vi.fn(),
  documentFindUnique: vi.fn(),
  accessLogCreate: vi.fn(),
  logAudit: vi.fn(),
  deliverViaMessaging: vi.fn(),
  resolveMessagingTarget: vi.fn(),
}))

vi.mock("@/lib/config/identity", async () => {
  const { parseLenderIdentity } = await vi.importActual<typeof import("@/lib/config/identity")>("@/lib/config/identity")
  const { VALID_LENDER_COLUMNS } = await import("@/lib/config/__fixtures__/lender-identity")
  return { getLenderIdentity: async () => parseLenderIdentity(VALID_LENDER_COLUMNS) }
})
vi.mock("@/lib/auth-guards", () => ({ requireApiRole }))
vi.mock("@/lib/tenant", () => ({
  withTenantContext: (
    _req: unknown,
    callback: (tenant: { id: string }) => unknown,
  ) => callback({ id: "tenant-1" }),
}))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    loanApplication: { findUnique: applicationFindUnique },
    pasqAcknowledgementToken: { updateMany: tokenUpdateMany },
    clientDocument: { findFirst: documentFindUnique },
    documentAccessLog: { create: accessLogCreate },
    $transaction: (...args: unknown[]) => transaction(...args),
  },
}))
vi.mock("@/lib/compliance/pasq-link-token.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/compliance/pasq-link-token.server")>()),
  mintPasqLinkToken: (...args: unknown[]) => mintPasqLinkToken(...args),
}))
vi.mock("@/lib/integrations/bulksms", () => ({
  sendSms: (...args: unknown[]) => sendSms(...args),
  sendWhatsApp: (...args: unknown[]) => sendWhatsApp(...args),
}))
vi.mock("@/lib/email/service", () => ({
  sendEmail: (...args: unknown[]) => sendEmail(...args),
}))
vi.mock("@/lib/messaging/route-delivery", () => ({
  deliverViaMessaging: (...args: unknown[]) => deliverViaMessaging(...args),
  resolveMessagingTarget: (...args: unknown[]) => resolveMessagingTarget(...args),
}))
vi.mock("@/lib/storage", () => ({
  readFile: (...args: unknown[]) => readFile(...args),
}))
vi.mock("@/lib/audit", () => ({
  logAudit: (...args: unknown[]) => logAudit(...args),
  AuditAction: new Proxy({}, { get: (_t, key) => String(key) }),
}))

import { POST } from "./route"

const context = { params: Promise.resolve({ id: "app-1" }) }

function request(body: Record<string, unknown>) {
  return new NextRequest("http://localhost/api/applications/app-1/pasq/send-link", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

describe("POST /api/applications/[id]/pasq/send-link", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv("NEXT_PUBLIC_PORTAL_URL", "https://portal.lender.example")
    vi.stubEnv("NEXTAUTH_URL", "https://app.lender.example")
    requireApiRole.mockResolvedValue({ user: { id: "officer-1", email: "officer@x.test" } })
    applicationFindUnique.mockResolvedValue({
      clientId: "client-1",
      status: "APPROVED",
      agreementGeneratedAt: null,
      pasqDocumentId: "pasq-doc-1",
      pasqDocumentSha256: "f".repeat(64),
      pasqAcknowledgedAt: null,
      client: {
        phone: "+27821110000",
        whatsapp: "+27822220000",
        email: "client@example.test",
        firstName: "Sipho",
        lastName: "Nkosi",
      },
    })
    transaction.mockImplementation(async (callback: (tx: unknown) => unknown) =>
      callback({ pasqAcknowledgementToken: { updateMany: tokenUpdateMany } }))
    mintPasqLinkToken.mockResolvedValue({
      id: "tok-1",
      secret: "s3cret",
      tokenHash: "h".repeat(64),
      expiresAt: new Date("2026-07-30T18:00:00Z"),
    })
    sendSms.mockResolvedValue({ ok: true, simulated: true })
    sendWhatsApp.mockResolvedValue({ ok: true, simulated: true })
    sendEmail.mockResolvedValue({ ok: true, providerOutcome: "ACCEPTED" })
    documentFindUnique.mockResolvedValue({
      id: "pasq-doc-1",
      fileName: "pasq-app-1.pdf",
      storagePath: "/store/pasq-app-1.pdf",
    })
    // Bytes whose sha256 the test recomputes; individual tests override the
    // application digest to force a match or mismatch.
    readFile.mockResolvedValue(Buffer.from("pasq bytes"))
    accessLogCreate.mockResolvedValue({ id: "log-1" })
    logAudit.mockResolvedValue(undefined)
  })

  it("sends ONLY to the number on the client record — a body-supplied destination is ignored", async () => {
    // A per-send override would let one staff account route the link to
    // itself and manufacture consumer acknowledgement evidence — the exact
    // channel this rebuild removes.
    const response = await POST(request({ channel: "SMS", sentTo: "+27829999999" }), context)

    expect(response.status).toBe(200)
    expect(sendSms).toHaveBeenCalledWith(expect.objectContaining({ to: "+27821110000" }))
    expect(mintPasqLinkToken).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      sentTo: "+27821110000",
    }))
  })

  // A deployment with BULKSMS_DRY_RUN=true sends nothing. Without this guard the route dispatched,
  // got a `simulated` result, and wrote a PASQ_LINK_SENT audit row for a link
  // the consumer never received.
  describe("SMS channel off (BULKSMS_DRY_RUN=true)", () => {
    afterEach(() => {
      delete process.env.BULKSMS_DRY_RUN
    })

    it("refuses an SMS send with 400 and dispatches nothing", async () => {
      process.env.BULKSMS_DRY_RUN = "true"

      const response = await POST(request({ channel: "SMS" }), context)

      expect(response.status).toBe(400)
      expect((await response.json()).error).toContain("SMS not enabled")
      expect(sendSms).not.toHaveBeenCalled()
      expect(mintPasqLinkToken).not.toHaveBeenCalled()
    })

    it("leaves the WhatsApp channel working", async () => {
      process.env.BULKSMS_DRY_RUN = "true"

      const response = await POST(request({ channel: "WHATSAPP" }), context)

      expect(response.status).toBe(200)
      expect(sendWhatsApp).toHaveBeenCalledOnce()
    })

    it("CHANNEL ON: SMS still sends", async () => {
      delete process.env.BULKSMS_DRY_RUN

      const response = await POST(request({ channel: "SMS" }), context)

      expect(response.status).toBe(200)
      expect(sendSms).toHaveBeenCalledOnce()
    })
  })

  it("refuses with 409 to send the link to contact details a dealer typed that staff have not verified", async () => {
    const base = {
      clientId: "client-1", status: "APPROVED", agreementGeneratedAt: null, pasqDocumentId: "pasq-doc-1",
      pasqDocumentSha256: "f".repeat(64), pasqAcknowledgedAt: null,
      client: { phone: "+27821110000", whatsapp: "+27822220000", email: "client@example.test", firstName: "Sipho", lastName: "Nkosi" },
    }
    applicationFindUnique.mockResolvedValue({ ...base, client: { ...base.client, createdByDealerId: "dealer-1", dealerContactVerifiedAt: null } })

    const response = await POST(request({ channel: "WHATSAPP" }), context)

    expect(response.status).toBe(409)
    expect((await response.json()).error).toMatch(/dealer captured this person's contact details/i)
    expect(mintPasqLinkToken).not.toHaveBeenCalled()
    expect(sendWhatsApp).not.toHaveBeenCalled()

    applicationFindUnique.mockResolvedValue({ ...base, client: { ...base.client, createdByDealerId: "dealer-1", dealerContactVerifiedAt: new Date("2026-10-19T10:00:00Z") } })
    expect((await POST(request({ channel: "WHATSAPP" }), context)).status).toBe(200)
  })

  it("refuses when the client record has no valid number for the channel", async () => {
    applicationFindUnique.mockResolvedValue({
      clientId: "client-1",
      status: "APPROVED",
      agreementGeneratedAt: null,
      pasqDocumentId: "pasq-doc-1",
      pasqDocumentSha256: "f".repeat(64),
      pasqAcknowledgedAt: null,
      client: { phone: "082-not-e164", whatsapp: null },
    })

    const response = await POST(request({ channel: "SMS", sentTo: "+27829999999" }), context)

    expect(response.status).toBe(422)
    expect((await response.json()).error).toContain("number on file")
    expect(mintPasqLinkToken).not.toHaveBeenCalled()
    expect(sendSms).not.toHaveBeenCalled()
  })

  it("mints inside a transaction and maps a concurrent-mint unique violation to 409", async () => {
    transaction.mockRejectedValueOnce(Object.assign(new Error("unique"), { code: "P2002" }))

    const response = await POST(request({ channel: "SMS" }), context)

    expect(response.status).toBe(409)
    expect(sendSms).not.toHaveBeenCalled()
  })

  it("EMAIL: sends the link to the address on file with the digest-matching PDF attached", async () => {
    const bytes = Buffer.from("pasq bytes")
    const digest = createHash("sha256").update(bytes).digest("hex")
    applicationFindUnique.mockResolvedValue({
      clientId: "client-1",
      status: "APPROVED",
      agreementGeneratedAt: null,
      pasqDocumentId: "pasq-doc-1",
      pasqDocumentSha256: digest,
      pasqAcknowledgedAt: null,
      client: {
        phone: "+27821110000",
        whatsapp: null,
        email: "client@example.test",
        firstName: "Sipho",
        lastName: "Nkosi",
      },
    })

    const response = await POST(request({ channel: "EMAIL", sentTo: "attacker@evil.test" }), context)

    expect(response.status).toBe(200)
    expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({
      to: "client@example.test",
      attachments: [expect.objectContaining({
        filename: "pasq-app-1.pdf",
        contentType: "application/pdf",
      })],
    }))
    expect(mintPasqLinkToken).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      channel: "EMAIL",
      sentTo: "client@example.test",
    }))
    // The audit must carry the MASKED address (POPIA) and say a PDF rode
    // along — replacing maskDestination with the raw value goes RED here.
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: "PASQ_LINK_SENT",
      newValue: expect.objectContaining({
        sentTo: "c*****@example.test",
        attachmentIncluded: true,
      }),
    }))
    // The disclosure is logged as the STAFF member's act — never as a client
    // 'view', which would forge the s.92(1) consumer-received evidence.
    expect(accessLogCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        accessorType: "staff",
        accessorId: "officer-1",
        action: "email_to_client",
      }),
    }))
    expect(sendSms).not.toHaveBeenCalled()
    expect(sendWhatsApp).not.toHaveBeenCalled()
  })

  it("EMAIL: escapes the client's name in the email HTML", async () => {
    const bytes = Buffer.from("pasq bytes")
    const digest = createHash("sha256").update(bytes).digest("hex")
    applicationFindUnique.mockResolvedValue({
      clientId: "client-1",
      status: "APPROVED",
      agreementGeneratedAt: null,
      pasqDocumentId: "pasq-doc-1",
      pasqDocumentSha256: digest,
      pasqAcknowledgedAt: null,
      client: {
        phone: "+27821110000",
        whatsapp: null,
        email: "client@example.test",
        firstName: '<a href="https://evil.test">Sipho</a>',
        lastName: null,
      },
    })

    const response = await POST(request({ channel: "EMAIL" }), context)

    expect(response.status).toBe(200)
    const call = sendEmail.mock.calls[0][0] as { html: string }
    expect(call.html).not.toContain('<a href="https://evil.test">')
    expect(call.html).toContain("&lt;a href=")
  })

  it("EMAIL: refuses (409, audited, nothing minted) when stored bytes do not match the bound digest", async () => {
    // pasqDocumentSha256 in the baseline fixture is 'f'.repeat(64) — the
    // mocked bytes hash to something else. A tampered quotation must never
    // be delivered, silently or otherwise.
    const response = await POST(request({ channel: "EMAIL" }), context)

    expect(response.status).toBe(409)
    expect(sendEmail).not.toHaveBeenCalled()
    expect(mintPasqLinkToken).not.toHaveBeenCalled()
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: "PASQ_LINK_SEND_FAILED",
      newValue: expect.objectContaining({ failure: "document_digest_mismatch", sent: false }),
    }))
  })

  it("EMAIL: refuses when the client record has no valid email address", async () => {
    applicationFindUnique.mockResolvedValue({
      clientId: "client-1",
      status: "APPROVED",
      agreementGeneratedAt: null,
      pasqDocumentId: "pasq-doc-1",
      pasqDocumentSha256: "f".repeat(64),
      pasqAcknowledgedAt: null,
      client: { phone: "+27821110000", whatsapp: null, email: "not-an-email", firstName: null, lastName: null },
    })

    const response = await POST(request({ channel: "EMAIL" }), context)

    expect(response.status).toBe(422)
    expect(sendEmail).not.toHaveBeenCalled()
    expect(mintPasqLinkToken).not.toHaveBeenCalled()
  })

  function emailScenarioWithMatchingDigest() {
    const bytes = Buffer.from("pasq bytes")
    const digest = createHash("sha256").update(bytes).digest("hex")
    applicationFindUnique.mockResolvedValue({
      clientId: "client-1",
      status: "APPROVED",
      agreementGeneratedAt: null,
      pasqDocumentId: "pasq-doc-1",
      pasqDocumentSha256: digest,
      pasqAcknowledgedAt: null,
      client: {
        phone: "+27821110000",
        whatsapp: null,
        email: "client@example.test",
        firstName: "Sipho",
        lastName: "Nkosi",
      },
    })
  }

  it("EMAIL: cancels the token when the provider definitely rejected the email", async () => {
    emailScenarioWithMatchingDigest()
    sendEmail.mockResolvedValue({ ok: false, error: "smtp_down", providerOutcome: "DEFINITELY_REJECTED" })

    const response = await POST(request({ channel: "EMAIL" }), context)

    expect(response.status).toBe(502)
    expect(tokenUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: "tok-1", usedAt: null, invalidatedAt: null }),
      data: expect.objectContaining({ invalidatedAt: expect.any(Date) }),
    }))
    // Definitely rejected: no disclosure happened, so no access-log row.
    expect(accessLogCreate).not.toHaveBeenCalled()
  })

  it("EMAIL: an ambiguous provider verdict still cancels the token but records the possible disclosure", async () => {
    emailScenarioWithMatchingDigest()
    sendEmail.mockResolvedValue({ ok: false, error: "socket closed mid-send", providerOutcome: "AMBIGUOUS" })

    const response = await POST(request({ channel: "EMAIL" }), context)

    expect(response.status).toBe(502)
    expect(tokenUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ invalidatedAt: expect.any(Date) }),
    }))
    // The quotation may have reached the consumer — POPIA disclosure row and
    // a truthful audit (never a claim of proven non-delivery).
    expect(accessLogCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ accessorType: "staff", action: "email_to_client" }),
    }))
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: "PASQ_LINK_SEND_FAILED",
      newValue: expect.objectContaining({ possiblyDelivered: true }),
    }))
  })

  it("cancels the token when delivery fails so no unreachable live credential survives", async () => {
    sendSms.mockResolvedValue({ ok: false, error: "gateway_down" })

    const response = await POST(request({ channel: "SMS" }), context)

    expect(response.status).toBe(502)
    expect(tokenUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: "tok-1", usedAt: null, invalidatedAt: null }),
      data: expect.objectContaining({ invalidatedAt: expect.any(Date) }),
    }))
  })
})

describe("POST /api/applications/[id]/pasq/send-link — MESSAGING_NEW_SEND_PASQ_LINK", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.MESSAGING_NEW_SEND_PASQ_LINK = "true"
    requireApiRole.mockResolvedValue({ user: { id: "officer-1", email: "officer@x.test" } })
    applicationFindUnique.mockResolvedValue({
      clientId: "client-1",
      status: "APPROVED",
      agreementGeneratedAt: null,
      pasqDocumentId: "pasq-doc-1",
      pasqDocumentSha256: createHash("sha256").update(Buffer.from("pasq bytes")).digest("hex"),
      pasqAcknowledgedAt: null,
      client: {
        phone: "+27821110000",
        whatsapp: "+27822220000",
        email: "client@example.test",
        firstName: "Sipho",
        lastName: "Nkosi",
      },
    })
    transaction.mockImplementation(async (callback: (tx: unknown) => unknown) =>
      callback({ pasqAcknowledgementToken: { updateMany: tokenUpdateMany } }))
    mintPasqLinkToken.mockResolvedValue({
      id: "tok-1",
      secret: "s3cret",
      tokenHash: "h".repeat(64),
      expiresAt: new Date("2026-07-30T18:00:00Z"),
    })
    documentFindUnique.mockResolvedValue({
      id: "pasq-doc-1",
      fileName: "pasq-app-1.pdf",
      storagePath: "/store/pasq-app-1.pdf",
    })
    readFile.mockResolvedValue(Buffer.from("pasq bytes"))
    accessLogCreate.mockResolvedValue({ id: "log-1" })
    logAudit.mockResolvedValue(undefined)
    resolveMessagingTarget.mockResolvedValue({
      ok: true,
      contact: { id: "contact-1" },
      template: { id: "tpl-pasq", tenantId: "tenant-1" },
    })
    deliverViaMessaging.mockResolvedValue({ ok: true, providerOutcome: "ACCEPTED" })
  })

  afterEach(() => {
    delete process.env.MESSAGING_NEW_SEND_PASQ_LINK
  })

  it("routes the email leg through sendMessage() and keeps the POPIA disclosure record", async () => {
    const response = await POST(request({ channel: "EMAIL" }), context)

    expect(response.status).toBe(200)
    expect(sendEmail).not.toHaveBeenCalled()
    expect(resolveMessagingTarget).toHaveBeenCalledWith(expect.objectContaining({
      channel: "EMAIL",
      value: "client@example.test",
      templateKey: "pasq_link_email",
    }))
    expect(deliverViaMessaging).toHaveBeenCalledWith(expect.objectContaining({
      channel: "EMAIL",
      category: "pasq-link",
      applicationId: "app-1",
      automaticRetry: false,
      vars: expect.objectContaining({ url: expect.stringContaining("/pasq/s3cret") }),
      attachments: [expect.objectContaining({ filename: "pasq-app-1.pdf" })],
    }))
    expect(accessLogCreate).toHaveBeenCalledOnce()
  })

  it("leaves the WhatsApp leg on the legacy path even with the flag on", async () => {
    // Routed through sendMessage(), WA resolves to WA_CLOUD for a tenant whose
    // waProvider is WA_CLOUD (the default is WA_UNOFFICIAL), and there an
    // out-of-window send needs an APPROVED WABA template. pasq_link_whatsapp
    // has none, and a new applicant who has never messaged in is ALWAYS
    // out-of-window — i.e. the normal PASQ case. Cutting it over would fail
    // every send. It moves once Meta has approved a template.
    sendWhatsApp.mockResolvedValue({ ok: true, simulated: false })

    const response = await POST(request({ channel: "WHATSAPP" }), context)

    expect(response.status).toBe(200)
    expect(sendWhatsApp).toHaveBeenCalledOnce()
    expect(deliverViaMessaging).not.toHaveBeenCalled()
    expect(resolveMessagingTarget).not.toHaveBeenCalled()
  })

  it("does not audit a dry-run as a real send — BULKSMS_DRY_RUN is true on prod", async () => {
    // The legacy sendSms/sendWhatsApp returned simulated:true under dry-run and
    // the audit reads it. If the new path dropped the field it would silently
    // read false and write PASQ_LINK_SENT for an s.92(1) quotation that never
    // left the system, with a live token and a 200 to the consultant.
    deliverViaMessaging.mockResolvedValue({ ok: true, simulated: true, providerOutcome: "ACCEPTED" })

    const response = await POST(request({ channel: "SMS" }), context)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(expect.objectContaining({ simulated: true }))
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({
      newValue: expect.objectContaining({ simulated: true }),
    }))
  })

  it("reports simulated:false for a real provider send", async () => {
    deliverViaMessaging.mockResolvedValue({ ok: true, simulated: false, providerOutcome: "ACCEPTED" })

    const response = await POST(request({ channel: "SMS" }), context)

    expect(await response.json()).toEqual(expect.objectContaining({ simulated: false }))
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({
      newValue: expect.objectContaining({ simulated: false }),
    }))
  })

  it("routes the SMS leg through sendMessage()", async () => {
    const response = await POST(request({ channel: "SMS" }), context)

    expect(response.status).toBe(200)
    expect(sendSms).not.toHaveBeenCalled()
    expect(resolveMessagingTarget).toHaveBeenCalledWith(expect.objectContaining({
      channel: "SMS",
      value: "27821110000",
      templateKey: "pasq_link_sms",
    }))
  })

  it.each([
    ["EMAIL", "client@example.test"],
    ["SMS", "27821110000"],
  ])("records %s against the SAME normalised value it resolved the Contact with", async (channel, value) => {
    await POST(request({ channel }), context)

    expect(resolveMessagingTarget).toHaveBeenCalledWith(expect.objectContaining({ value }))
    expect(deliverViaMessaging).toHaveBeenCalledWith(expect.objectContaining({ toValue: value }))
  })

  it("writes NO POPIA disclosure record when the email failure was pre-dispatch", async () => {
    deliverViaMessaging.mockResolvedValue({
      ok: false,
      error: "Email is not configured for this tenant",
      providerOutcome: "DEFINITELY_REJECTED",
    })

    const response = await POST(request({ channel: "EMAIL" }), context)

    expect(response.status).toBe(502)
    expect(accessLogCreate).not.toHaveBeenCalled()
  })

  it("invalidates the minted token when the messaging target cannot be resolved", async () => {
    resolveMessagingTarget.mockResolvedValue({ ok: false, reason: "no Contact row for this email address" })

    const response = await POST(request({ channel: "EMAIL" }), context)

    expect(response.status).toBe(502)
    expect(deliverViaMessaging).not.toHaveBeenCalled()
    // A live signing credential must not survive a send that never happened.
    expect(tokenUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ invalidatedAt: expect.any(Date) }),
    }))
    expect(accessLogCreate).not.toHaveBeenCalled()
  })
})
