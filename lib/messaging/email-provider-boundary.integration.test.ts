import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const { sendMail, closeTransport, findEmailConfig, createEmailLog } = vi.hoisted(() => ({
  sendMail: vi.fn(),
  closeTransport: vi.fn(),
  findEmailConfig: vi.fn(),
  createEmailLog: vi.fn(),
}))

vi.mock("nodemailer", () => ({
  default: {
    createTransport: () => ({ sendMail, close: closeTransport }),
  },
}))

vi.mock("@/lib/prisma", () => ({
  prisma: {
    emailConfig: { findUnique: findEmailConfig },
    emailLog: { create: createEmailLog },
  },
}))

vi.mock("@/lib/integrations/bulksms", () => ({ sendSms: vi.fn() }))
vi.mock("@/lib/whatsapp", () => ({ sendWhatsAppMessage: vi.fn() }))

import { dispatch } from "./providers"

// This suite dispatches to a non-company address, which the recipient allowlist
// correctly refuses by default (lib/email/recipient-guard.ts). Opt out
// EXPLICITLY rather than widening the allowlist for a fixture — the guard
// exists because staging once mailed real members of the public.
beforeEach(() => {
  process.env.EMAIL_DELIVERY_MODE = "unrestricted"
})
afterEach(() => {
  delete process.env.EMAIL_DELIVERY_MODE
})


const smtpConfig = {
  provider: "IMAP_SMTP",
  active: true,
  fromName: "Acme Test",
  fromAddress: "noreply@example.test",
  smtpHost: "smtp.example.test",
  smtpPort: 465,
  smtpUser: "noreply@example.test",
  smtpPass: "synthetic-secret",
  useTls: true,
  replyToAddress: null,
}

const rendered = {
  subject: "Synthetic subject",
  html: "<p>Synthetic body</p>",
  text: "Synthetic body",
}

describe("email provider boundary integration", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    createEmailLog.mockResolvedValue({})
  })

  afterEach(() => vi.unstubAllGlobals())

  it("carries SMTP's real Message-ID through sendEmail and dispatch into truthful evidence", async () => {
    findEmailConfig.mockResolvedValue(smtpConfig)
    sendMail.mockResolvedValue({ messageId: " <smtp-real-1@example.test> " })

    const result = await dispatch("EMAIL", "SMTP", rendered, {
      tenantId: "tenant-test",
      toValue: "customer@example.test",
      category: "SERVICE",
      replyTo: "support@example.test",
      listUnsubscribeUrl: "https://example.test/unsubscribe?token=synthetic",
      inReplyTo: "<inbound-1@example.test>",
      references: ["<root-1@example.test>", "<inbound-1@example.test>"],
      attachments: [{
        filename: "proof.pdf",
        contentType: "application/pdf",
        content: Buffer.from("synthetic-pdf"),
      }],
    })
    if (result.simulated === true) throw new Error("Email dispatch cannot be simulated")

    expect(result).toEqual({
      providerMessageId: "<smtp-real-1@example.test>",
      acceptedAt: expect.any(Date),
    })
    expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({
      replyTo: "support@example.test",
      inReplyTo: "<inbound-1@example.test>",
      references: ["<root-1@example.test>", "<inbound-1@example.test>"],
      attachments: [expect.objectContaining({ filename: "proof.pdf" })],
      headers: expect.objectContaining({
        "List-Unsubscribe": "<https://example.test/unsubscribe?token=synthetic>",
      }),
    }))
    expect(createEmailLog).toHaveBeenCalledWith({
      data: expect.objectContaining({
        status: "SENT",
        provider: "SMTP",
        messageId: "<smtp-real-1@example.test>",
        providerEvidenceReference: undefined,
        sentAt: result.acceptedAt,
        errorMessage: undefined,
      }),
    })
  })

  it("carries unique Graph request correlation without manufacturing a provider Message-ID", async () => {
    findEmailConfig.mockResolvedValue({
      ...smtpConfig,
      provider: "MSGRAPH",
      tenantAzureId: "azure-tenant",
      clientId: "azure-client",
      clientSecret: "azure-secret",
    })
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: "token" }) })
      .mockResolvedValueOnce({
        ok: true,
        status: 202,
        headers: new Headers({ "request-id": "graph-request-1" }),
      })
    vi.stubGlobal("fetch", fetchMock)

    const result = await dispatch("EMAIL", "MSGRAPH", rendered, {
      tenantId: "tenant-test",
      toValue: "customer@example.test",
      category: "SERVICE",
    })
    if (result.simulated === true) throw new Error("Email dispatch cannot be simulated")

    expect(result.acceptedAt).toBeInstanceOf(Date)
    expect(result.evidenceReference).toMatch(
      /^MSGRAPH_REQUEST_ID:graph-request-1;CLIENT_REQUEST_ID:[0-9a-f-]{36}$/,
    )
    expect(result).not.toHaveProperty("providerMessageId")
    const graphRequest = fetchMock.mock.calls[1]
    expect(graphRequest[1].headers).toEqual(expect.objectContaining({
      "return-client-request-id": "true",
      "client-request-id": expect.stringMatching(/^[0-9a-f-]{36}$/),
    }))
    expect(createEmailLog).toHaveBeenCalledWith({
      data: expect.objectContaining({
        status: "SENT",
        provider: "MSGRAPH",
        messageId: undefined,
        providerEvidenceReference: result.evidenceReference,
        sentAt: result.acceptedAt,
        errorMessage: undefined,
      }),
    })
  })

  it("holds an id-less SMTP success as ambiguous instead of claiming SENT", async () => {
    findEmailConfig.mockResolvedValue(smtpConfig)
    sendMail.mockResolvedValue({})

    await expect(dispatch("EMAIL", "SMTP", rendered, {
      tenantId: "tenant-test",
      toValue: "customer@example.test",
    })).rejects.toMatchObject({
      outcome: "AMBIGUOUS",
      message: expect.stringMatching(/without a provider message id/i),
    })
    expect(createEmailLog).toHaveBeenCalledWith({
      data: expect.objectContaining({
        status: "FAILED",
        errorMessage: expect.stringContaining("[PROVIDER_OUTCOME_AMBIGUOUS]"),
        provider: "SMTP",
        messageId: undefined,
        sentAt: undefined,
      }),
    })
  })

  it("refuses a config flip that contradicts the durable provider reservation", async () => {
    findEmailConfig.mockResolvedValue({ ...smtpConfig, provider: "MSGRAPH" })
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)

    await expect(dispatch("EMAIL", "SMTP", rendered, {
      tenantId: "tenant-test",
      toValue: "customer@example.test",
    })).rejects.toMatchObject({ outcome: "DEFINITELY_REJECTED" })
    expect(sendMail).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(createEmailLog).toHaveBeenCalledWith({
      data: expect.objectContaining({
        status: "FAILED",
        provider: "MSGRAPH",
        errorMessage: expect.stringMatching(/changed from SMTP to MSGRAPH/),
      }),
    })
  })
})
