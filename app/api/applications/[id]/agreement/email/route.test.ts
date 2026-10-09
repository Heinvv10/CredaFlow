import { createHash } from "node:crypto"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const {
  requireApiRole,
  applicationFindUnique,
  documentFindUnique,
  accessLogCreate,
  sendEmail,
  readFile,
  logAudit,
  deliverViaMessaging,
  resolveMessagingTarget,
} = vi.hoisted(() => ({
  requireApiRole: vi.fn(),
  applicationFindUnique: vi.fn(),
  documentFindUnique: vi.fn(),
  accessLogCreate: vi.fn(),
  sendEmail: vi.fn(),
  readFile: vi.fn(),
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
    clientDocument: { findFirst: documentFindUnique },
    documentAccessLog: { create: accessLogCreate },
  },
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

function request() {
  return new NextRequest("http://localhost/api/applications/app-1/agreement/email", {
    method: "POST",
  })
}

const AGREEMENT_BYTES = Buffer.from("countersigned agreement pdf")
const AGREEMENT_SHA = createHash("sha256").update(AGREEMENT_BYTES).digest("hex")

describe("POST /api/applications/[id]/agreement/email", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    requireApiRole.mockResolvedValue({ user: { id: "officer-1", email: "officer@x.test" } })
    applicationFindUnique.mockResolvedValue({
      reference: "APP-1",
      clientId: "client-1",
      agreementDocumentId: "agr-doc-1",
      agreementDocumentSha256: AGREEMENT_SHA,
      agreementCountersignedAt: new Date("2026-07-28T21:23:00Z"),
      client: { email: "client@example.test", firstName: "Sipho", lastName: "Nkosi" },
    })
    documentFindUnique.mockResolvedValue({
      id: "agr-doc-1",
      fileName: "credit-agreement-APP-1.pdf",
      storagePath: "/store/credit-agreement-APP-1.pdf",
    })
    readFile.mockResolvedValue(AGREEMENT_BYTES)
    sendEmail.mockResolvedValue({ ok: true, providerOutcome: "ACCEPTED" })
    accessLogCreate.mockResolvedValue({ id: "log-1" })
    logAudit.mockResolvedValue(undefined)
  })

  it("emails the countersigned agreement to the address on file and logs the disclosure", async () => {
    const response = await POST(request(), context)

    expect(response.status).toBe(200)
    expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({
      to: "client@example.test",
      attachments: [expect.objectContaining({
        filename: "credit-agreement-APP-1.pdf",
        contentType: "application/pdf",
      })],
    }))
    expect(accessLogCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        documentId: "agr-doc-1",
        accessorType: "staff",
        accessorId: "officer-1",
        action: "email_to_client",
      }),
    }))
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: "AGREEMENT_EMAILED_TO_CLIENT",
      // MASKED address in the audit — replacing maskDestination with the raw
      // value goes RED here (POPIA control).
      newValue: expect.objectContaining({ sentTo: "c*****@example.test" }),
    }))
    expect(await response.json()).toEqual(expect.objectContaining({ sentTo: "c*****@example.test" }))
  })

  it("constrains the document lookup to this client's live CREDIT_AGREEMENT", async () => {
    // The digest proves content, not lifecycle: a soft-deleted or re-typed
    // row must never be mailed. The lookup must carry all four constraints.
    await POST(request(), context)
    expect(documentFindUnique).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        id: "agr-doc-1",
        clientId: "client-1",
        docType: "CREDIT_AGREEMENT",
        deletedAt: null,
      }),
    }))
  })

  it("delivers the EXECUTED artifact — the one that carries both signatures", async () => {
    // The whole point of the executed artifact: before this, the copy sent
    // under NCA s93 was the document with the BLANK signature line.
    const EXECUTED_BYTES = Buffer.from("executed agreement pdf with signatures")
    const EXECUTED_SHA = createHash("sha256").update(EXECUTED_BYTES).digest("hex")
    applicationFindUnique.mockResolvedValue({
      reference: "APP-1",
      clientId: "client-1",
      agreementDocumentId: "agr-doc-1",
      agreementDocumentSha256: AGREEMENT_SHA,
      agreementExecutedDocumentId: "executed-doc-1",
      agreementExecutedDocumentSha256: EXECUTED_SHA,
      agreementCountersignedAt: new Date("2026-07-28T21:23:00Z"),
      client: { email: "client@example.test", firstName: "Sipho", lastName: "Nkosi" },
    })
    documentFindUnique.mockResolvedValue({
      id: "executed-doc-1",
      fileName: "credit-agreement-executed-app-1.pdf",
      storagePath: "/store/executed.pdf",
    })
    readFile.mockResolvedValue(EXECUTED_BYTES)

    const response = await POST(request(), context)
    expect(response.status).toBe(200)

    expect(documentFindUnique).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        id: "executed-doc-1",
        docType: "EXECUTED_CREDIT_AGREEMENT",
        deletedAt: null,
      }),
    }))
    // ...and the bytes actually attached are the executed ones.
    expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({
      attachments: [expect.objectContaining({ content: EXECUTED_BYTES })],
    }))
  })

  it("audits the digest of the document it actually sent", async () => {
    // Pairing the executed document's id with the unsigned document's digest
    // would answer "which bytes did the consumer receive" with a digest that
    // matches the document that was NOT sent.
    const EXECUTED_BYTES = Buffer.from("executed agreement pdf with signatures")
    const EXECUTED_SHA = createHash("sha256").update(EXECUTED_BYTES).digest("hex")
    applicationFindUnique.mockResolvedValue({
      reference: "APP-1",
      clientId: "client-1",
      agreementDocumentId: "agr-doc-1",
      agreementDocumentSha256: AGREEMENT_SHA,
      agreementExecutedDocumentId: "executed-doc-1",
      agreementExecutedDocumentSha256: EXECUTED_SHA,
      agreementCountersignedAt: new Date("2026-07-28T21:23:00Z"),
      client: { email: "client@example.test", firstName: "Sipho", lastName: "Nkosi" },
    })
    documentFindUnique.mockResolvedValue({
      id: "executed-doc-1",
      fileName: "executed.pdf",
      storagePath: "/store/executed.pdf",
    })
    readFile.mockResolvedValue(EXECUTED_BYTES)

    await POST(request(), context)

    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({
      newValue: expect.objectContaining({
        documentId: "executed-doc-1",
        documentSha256: EXECUTED_SHA,
        deliveredExecutedArtifact: true,
      }),
    }))
  })

  it("still delivers to a loan countersigned before the executed artifact existed", async () => {
    // These consumers are owed their statutory copy too; the unsigned
    // agreement remains the fallback rather than a hard failure.
    const response = await POST(request(), context)
    expect(response.status).toBe(200)
    expect(documentFindUnique).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ docType: "CREDIT_AGREEMENT" }),
    }))
    expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({
      attachments: [expect.objectContaining({ content: AGREEMENT_BYTES })],
    }))
  })

  it("checks the EXECUTED digest, not the unsigned one", async () => {
    const EXECUTED_BYTES = Buffer.from("executed agreement pdf with signatures")
    applicationFindUnique.mockResolvedValue({
      reference: "APP-1",
      clientId: "client-1",
      agreementDocumentId: "agr-doc-1",
      agreementDocumentSha256: AGREEMENT_SHA,
      agreementExecutedDocumentId: "executed-doc-1",
      // Deliberately the WRONG digest for these bytes.
      agreementExecutedDocumentSha256: "f".repeat(64),
      agreementCountersignedAt: new Date("2026-07-28T21:23:00Z"),
      client: { email: "client@example.test", firstName: "Sipho", lastName: "Nkosi" },
    })
    documentFindUnique.mockResolvedValue({
      id: "executed-doc-1",
      fileName: "executed.pdf",
      storagePath: "/store/executed.pdf",
    })
    readFile.mockResolvedValue(EXECUTED_BYTES)

    const response = await POST(request(), context)
    expect(response.status).toBe(409)
    expect(sendEmail).not.toHaveBeenCalled()
  })

  it("escapes the client's name in the email HTML", async () => {
    applicationFindUnique.mockResolvedValue({
      reference: "APP-1",
      clientId: "client-1",
      agreementDocumentId: "agr-doc-1",
      agreementDocumentSha256: AGREEMENT_SHA,
      agreementCountersignedAt: new Date("2026-07-28T21:23:00Z"),
      client: { email: "client@example.test", firstName: '<a href="https://evil.test">Sipho</a>', lastName: null },
    })

    const response = await POST(request(), context)

    expect(response.status).toBe(200)
    const call = sendEmail.mock.calls[0][0] as { html: string }
    expect(call.html).not.toContain('<a href="https://evil.test">')
    expect(call.html).toContain("&lt;a href=")
  })

  it("refuses before the provider countersign — there is no concluded agreement to deliver", async () => {
    applicationFindUnique.mockResolvedValue({
      reference: "APP-1",
      clientId: "client-1",
      agreementDocumentId: "agr-doc-1",
      agreementDocumentSha256: AGREEMENT_SHA,
      agreementCountersignedAt: null,
      client: { email: "client@example.test", firstName: null, lastName: null },
    })

    const response = await POST(request(), context)

    expect(response.status).toBe(409)
    expect(sendEmail).not.toHaveBeenCalled()
  })

  it("refuses when the client record has no valid email address", async () => {
    applicationFindUnique.mockResolvedValue({
      reference: "APP-1",
      clientId: "client-1",
      agreementDocumentId: "agr-doc-1",
      agreementDocumentSha256: AGREEMENT_SHA,
      agreementCountersignedAt: new Date("2026-07-28T21:23:00Z"),
      client: { email: null, firstName: null, lastName: null },
    })

    const response = await POST(request(), context)

    expect(response.status).toBe(422)
    expect(sendEmail).not.toHaveBeenCalled()
  })

  it("REFUSES delivery when stored bytes no longer match the recorded digest", async () => {
    // Never deliver a document that cannot be proven to be the one signed —
    // a swapped file on disk must be investigated, not mailed.
    readFile.mockResolvedValue(Buffer.from("tampered bytes"))

    const response = await POST(request(), context)

    expect(response.status).toBe(409)
    expect(sendEmail).not.toHaveBeenCalled()
    expect(accessLogCreate).not.toHaveBeenCalled()
    // The strongest integrity signal must leave a durable record.
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: "AGREEMENT_EMAIL_FAILED",
      newValue: expect.objectContaining({ failure: "document_digest_mismatch", sent: false }),
    }))
  })

  it("502s with no disclosure row when the provider definitely rejected the email", async () => {
    sendEmail.mockResolvedValue({ ok: false, error: "smtp_down", providerOutcome: "DEFINITELY_REJECTED" })

    const response = await POST(request(), context)

    expect(response.status).toBe(502)
    expect(accessLogCreate).not.toHaveBeenCalled()
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: "AGREEMENT_EMAIL_FAILED",
      newValue: expect.objectContaining({ possiblyDelivered: false }),
    }))
  })

  it("records the possible disclosure when the provider verdict is ambiguous", async () => {
    // Connection dropped mid-submission: the agreement MAY have reached the
    // consumer. POPIA disclosure recording errs on the side of existing, and
    // the audit never claims proven non-delivery (Section 129 rule).
    sendEmail.mockResolvedValue({ ok: false, error: "socket closed mid-send", providerOutcome: "AMBIGUOUS" })

    const response = await POST(request(), context)

    expect(response.status).toBe(502)
    expect(accessLogCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ accessorType: "staff", action: "email_to_client" }),
    }))
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: "AGREEMENT_EMAIL_FAILED",
      newValue: expect.objectContaining({ possiblyDelivered: true }),
    }))
  })
})

describe("POST /api/applications/[id]/agreement/email — MESSAGING_NEW_SEND_AGREEMENT_DELIVERY", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.MESSAGING_NEW_SEND_AGREEMENT_DELIVERY = "true"
    requireApiRole.mockResolvedValue({ user: { id: "officer-1", email: "officer@x.test" } })
    applicationFindUnique.mockResolvedValue({
      reference: "APP-1",
      clientId: "client-1",
      agreementDocumentId: "agr-doc-1",
      agreementDocumentSha256: AGREEMENT_SHA,
      agreementCountersignedAt: new Date("2026-07-28T21:23:00Z"),
      client: { email: "Client@Example.test", firstName: "Sipho", lastName: "Nkosi" },
    })
    documentFindUnique.mockResolvedValue({
      id: "agr-doc-1",
      fileName: "credit-agreement-APP-1.pdf",
      storagePath: "/store/credit-agreement-APP-1.pdf",
    })
    readFile.mockResolvedValue(AGREEMENT_BYTES)
    accessLogCreate.mockResolvedValue({ id: "log-1" })
    logAudit.mockResolvedValue(undefined)
    resolveMessagingTarget.mockResolvedValue({
      ok: true,
      contact: { id: "contact-1" },
      template: { id: "tpl-agreement", tenantId: "tenant-1" },
    })
    deliverViaMessaging.mockResolvedValue({ ok: true, providerOutcome: "ACCEPTED" })
  })

  afterEach(() => {
    delete process.env.MESSAGING_NEW_SEND_AGREEMENT_DELIVERY
  })

  it("routes the send through sendMessage() so it lands on the comms timeline", async () => {
    const response = await POST(request(), context)

    expect(response.status).toBe(200)
    expect(sendEmail).not.toHaveBeenCalled()
    expect(resolveMessagingTarget).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: "tenant-1",
      channel: "EMAIL",
      // Normalised: the ContactIdentity index is strict-equality.
      value: "client@example.test",
      templateKey: "agreement_delivery_email",
    }))
    expect(deliverViaMessaging).toHaveBeenCalledWith(expect.objectContaining({
      contactId: "contact-1",
      channel: "EMAIL",
      category: "agreement-delivery",
      applicationId: "app-1",
      createdById: "officer-1",
      // Attachment bytes are not replayable from the Message row.
      automaticRetry: false,
      vars: expect.objectContaining({ applicationReference: "APP-1", greeting: " Sipho Nkosi" }),
      attachments: [expect.objectContaining({ content: AGREEMENT_BYTES })],
    }))
    expect(accessLogCreate).toHaveBeenCalledOnce()
  })

  it("refuses rather than silently dropping the s.93(1) copy when the Contact row is missing", async () => {
    resolveMessagingTarget.mockResolvedValue({ ok: false, reason: "no Contact row for this email address" })

    const response = await POST(request(), context)

    expect(response.status).toBe(502)
    expect(deliverViaMessaging).not.toHaveBeenCalled()
    // Nothing left the system, so no POPIA disclosure record may be forged.
    expect(accessLogCreate).not.toHaveBeenCalled()
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: "AGREEMENT_EMAIL_FAILED",
      newValue: expect.objectContaining({ failure: "no Contact row for this email address" }),
    }))
  })

  it("writes NO disclosure record when the failure was provably pre-dispatch", async () => {
    // e.g. no EmailConfig, a missing template var, the redaction guard. The
    // agreement never left the system, so a DocumentAccessLog "email_to_client"
    // row would assert a POPIA disclosure that did not happen — and the
    // officer would be told it "may have reached the client".
    deliverViaMessaging.mockResolvedValue({
      ok: false,
      error: "Email is not configured for this tenant",
      providerOutcome: "DEFINITELY_REJECTED",
    })

    const response = await POST(request(), context)

    expect(response.status).toBe(502)
    expect(accessLogCreate).not.toHaveBeenCalled()
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: "AGREEMENT_EMAIL_FAILED",
      newValue: expect.objectContaining({ possiblyDelivered: false }),
    }))
  })

  it("passes toName so the EmailLog row is not anonymous", async () => {
    await POST(request(), context)

    expect(deliverViaMessaging).toHaveBeenCalledWith(expect.objectContaining({
      toName: "Sipho Nkosi",
    }))
  })

  it("keeps a POPIA disclosure record when the provider outcome is ambiguous", async () => {
    deliverViaMessaging.mockResolvedValue({ ok: false, error: "timeout", providerOutcome: "AMBIGUOUS" })

    const response = await POST(request(), context)

    expect(response.status).toBe(502)
    expect(accessLogCreate).toHaveBeenCalledOnce()
  })
})
