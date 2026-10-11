/* eslint-disable @typescript-eslint/no-explicit-any */
// vi.fn() mock resolved values don't match full Prisma return types — the
// partial shapes returned here are sufficient for the unit under test and the
// `as any` boundary keeps the mocks readable without duplicating every column.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: vi.fn(),
    $queryRawUnsafe: vi.fn(),
    $executeRawUnsafe: vi.fn(),
    contact: { findUnique: vi.fn() },
    contactConsent: { findFirst: vi.fn() },
    tenant: { findUnique: vi.fn() },
    emailConfig: { findUnique: vi.fn() },
    commsSettings: { findUnique: vi.fn() },
    conversation: { findFirst: vi.fn(), create: vi.fn(), updateMany: vi.fn() },
    message: { create: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    notificationLog: { updateMany: vi.fn() },
    auditLog: { create: vi.fn() },
  },
}))

import {
  MessageIdempotencyConflictError,
  MessageReconciliationRequiredError,
  SendBlockedError,
  canSendTx,
  resolveProvider,
  resolveOrCreateConversationTx,
  sendMessage,
} from "./send"
import { dispatch, ProviderDispatchError } from "./providers"
import { prisma } from "@/lib/prisma"
import { messagePayloadFingerprint } from "./payload-fingerprint"
import { REDACTED_BODY_PLACEHOLDER } from "./redaction"
import { bulkSmsHttpFailureOutcome } from "@/lib/integrations/bulksms"
import { waHttpFailureOutcome } from "@/lib/whatsapp"
import { graphHttpFailureOutcome } from "@/lib/email/service"

vi.mock("./providers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./providers")>()),
  dispatch: vi.fn(),
}))

describe("SendBlockedError", () => {
  it("is an Error subclass with a `reason` field", () => {
    const err = new SendBlockedError("NO_CONSENT_ON_FILE")
    expect(err).toBeInstanceOf(Error)
    expect(err.reason).toBe("NO_CONSENT_ON_FILE")
    expect(err.name).toBe("SendBlockedError")
  })
})

const serviceTemplate = {
  id: "tpl1", tenantId: "tn1", key: "test", category: "SERVICE",
  purposeRequired: null, statutoryOverride: false,
} as any

describe("resolveProvider", () => {
  it.each([
    ["IMAP_SMTP", "SMTP"],
    ["MSGRAPH", "MSGRAPH"],
  ] as const)("returns the configured %s email transport as %s", async (configured, expected) => {
    vi.mocked(prisma.emailConfig.findUnique).mockResolvedValue({ active: true, provider: configured } as any)
    expect(await resolveProvider("EMAIL", "tn1")).toBe(expected)
  })

  it("refuses to invent an email provider when the tenant has no active config", async () => {
    vi.mocked(prisma.emailConfig.findUnique).mockResolvedValue(null)
    await expect(resolveProvider("EMAIL", "tn1")).rejects.toThrow(/not configured/i)
  })

  it("returns BULKSMS for SMS", async () => {
    expect(await resolveProvider("SMS")).toBe("BULKSMS")
  })

  it("returns WA_UNOFFICIAL for WHATSAPP", async () => {
    expect(await resolveProvider("WHATSAPP")).toBe("WA_UNOFFICIAL")
  })

  it("throws for unsupported channels", async () => {
    await expect(resolveProvider("VOICE")).rejects.toThrow(/voice/i)
    await expect(resolveProvider("MANUAL")).rejects.toThrow(/manual/i)
  })
})

const sendOpts = {
  contactId: "ct1",
  channel: "EMAIL" as const,
  template: { tenantId: "tn1" } as any,
  vars: {},
  toValue: "x@y.com",
} as any

describe("resolveOrCreateConversationTx", () => {
  beforeEach(() => vi.clearAllMocks())

  it("returns the existing conversationId when opts.conversationId is set", async () => {
    const tx = { conversation: { findFirst: vi.fn(), create: vi.fn() } } as any
    const r = await resolveOrCreateConversationTx(tx, { ...sendOpts, conversationId: "cv-existing" })
    expect(r).toBe("cv-existing")
    expect(tx.conversation.findFirst).not.toHaveBeenCalled()
    expect(tx.conversation.create).not.toHaveBeenCalled()
  })

  it("creates a new Conversation when none provided", async () => {
    const tx = {
      conversation: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({ id: "cv-new" }),
      },
    } as any
    const r = await resolveOrCreateConversationTx(tx, sendOpts)
    expect(r).toBe("cv-new")
    expect(tx.conversation.create).toHaveBeenCalledOnce()
    const call = tx.conversation.create.mock.calls[0][0]
    expect(call.data.tenantId).toBe("tn1")
    expect(call.data.contactId).toBe("ct1")
    expect(call.data.channel).toBe("EMAIL")
    expect(call.data.status).toBe("OPEN")
  })
})

describe("canSendTx", () => {
  beforeEach(() => vi.clearAllMocks())

  it("acquires FOR UPDATE locks before evaluating", async () => {
    const tx = {
      $queryRawUnsafe: vi.fn()
        .mockResolvedValueOnce([{ id: "ct1" }])
        .mockResolvedValueOnce([]),
      contact: { findUnique: vi.fn().mockResolvedValue({
        id: "ct1", tenantId: "tn1", status: "CLIENT", blockedAt: null, client: { loans: [] },
      }) },
      contactConsent: { findFirst: vi.fn().mockResolvedValue(null) },
      tenant: { findUnique: vi.fn().mockResolvedValue({
        insuranceCrossSellS69OpinionReceived: false,
        softOptInClosedLoanTailEnabled: false,
      }) },
    } as any

    await canSendTx(tx, "ct1", "EMAIL", serviceTemplate)

    expect(tx.$queryRawUnsafe).toHaveBeenCalled()
    const contactSql = tx.$queryRawUnsafe.mock.calls[0]?.[0] as string
    const consentSql = tx.$queryRawUnsafe.mock.calls[1]?.[0] as string
    expect(contactSql).toMatch(/FROM "Contact"[\s\S]*FOR UPDATE/i)
    expect(consentSql).toMatch(/FROM "ContactConsent"[\s\S]*FOR UPDATE/i)
    expect(tx.$queryRawUnsafe.mock.calls[0]?.slice(1)).toEqual(["ct1", "tn1"])
    expect(tx.$queryRawUnsafe.mock.calls[1]?.slice(1)).toEqual(["tn1", "ct1", "EMAIL"])
    expect(tx.$queryRawUnsafe.mock.invocationCallOrder[0]).toBeLessThan(
      tx.contactConsent.findFirst.mock.invocationCallOrder[0],
    )
  })

  it("returns the same Eligibility shape canSend returns", async () => {
    const tx = {
      $queryRawUnsafe: vi.fn()
        .mockResolvedValueOnce([{ id: "ct1" }])
        .mockResolvedValueOnce([]),
      contact: { findUnique: vi.fn().mockResolvedValue({
        id: "ct1", tenantId: "tn1", status: "CLIENT", blockedAt: null, client: { loans: [] },
      }) },
      contactConsent: { findFirst: vi.fn().mockResolvedValue(null) },
      tenant: { findUnique: vi.fn().mockResolvedValue({
        insuranceCrossSellS69OpinionReceived: false,
        softOptInClosedLoanTailEnabled: false,
      }) },
    } as any

    const r = await canSendTx(tx, "ct1", "EMAIL", serviceTemplate)
    expect(r).toEqual({
      ok: true,
      basis: "SERVICE_COMMS_NCA",
      // Facts only: this fixture is a CLIENT with `loans: []`. basisEvidence
      // is the audit record, so it states what was established, not a
      // conclusion about the relationship.
      evidence: "service template test — contact status=CLIENT, loans=0",
    })
  })
})

const fullTemplate = {
  id: "tpl1", tenantId: "tn1", key: "test", category: "SERVICE",
  purposeRequired: null, statutoryOverride: false,
  subject: "Hello", body: "Hi {{name}}", bodyTemplate: null,
} as any
const providerAcceptedAt = new Date("2026-07-19T10:00:00.000Z")

function exactEmailFingerprint(): string {
  return messagePayloadFingerprint({
    tenantId: "tn1",
    contactId: "ct1",
    channel: "EMAIL",
    provider: "SMTP",
    templateId: "tpl1",
    rendered: { subject: "Hello", text: "Hi Sipho", html: null },
    toValue: "x@y.com",
    automaticRetry: false,
    failureOwner: "MESSAGING",
  })
}

function buildTx(overrides: any = {}) {
  let currentMessage: any = null
  const message = {
    create: vi.fn().mockImplementation(async ({ data }: any) => {
      currentMessage = {
        id: "msg1",
        ...data,
        retryCount: data.retryCount ?? 0,
        createdAt: new Date(),
      }
      return currentMessage
    }),
    findUnique: vi.fn().mockResolvedValue(null),
    findFirst: vi.fn().mockImplementation(async () => currentMessage),
    findFirstOrThrow: vi.fn().mockImplementation(async () => currentMessage),
    updateMany: vi.fn().mockImplementation(async ({ data }: any) => {
      currentMessage = { ...currentMessage, ...data }
      return { count: 1 }
    }),
    update: vi.fn().mockImplementation(async ({ data }: any) => {
      currentMessage = { ...currentMessage, ...data }
      return currentMessage
    }),
    ...(overrides.message ?? {}),
  }
  const conversation = {
    findFirst: vi.fn().mockResolvedValue(null),
    create: vi.fn().mockResolvedValue({ id: "cv1" }),
    updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    ...(overrides.conversation ?? {}),
  }
  return {
    $executeRawUnsafe: vi.fn().mockResolvedValue(1),
    $queryRawUnsafe: vi.fn(async (query: string) =>
      query.includes('FROM "Contact"') ? [{ id: "ct1" }] : [],
    ),
    contact: { findUnique: vi.fn().mockResolvedValue({
      id: "ct1", tenantId: "tn1", status: "CLIENT", blockedAt: null,
      client: { loans: [] },
    }) },
    contactConsent: { findFirst: vi.fn().mockResolvedValue(null) },
    tenant: { findUnique: vi.fn().mockResolvedValue({
      insuranceCrossSellS69OpinionReceived: false,
      softOptInClosedLoanTailEnabled: false,
    }) },
    auditLog: { create: vi.fn().mockResolvedValue({ id: "audit-1" }) },
    notificationLog: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    ...overrides,
    // Preserve the merged Message delegate when unrelated overrides are used.
    conversation,
    message,
  }
}

describe("sendMessage", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(prisma.emailConfig.findUnique).mockResolvedValue({ active: true, provider: "IMAP_SMTP" } as any)
    vi.mocked(prisma.auditLog.create).mockResolvedValue({} as any)
  })
  afterEach(() => {
    // Env vars set in some tests below MUST NOT leak across cases — vitest
    // shares the worker process, so a stale UNSUB_TOKEN_SECRET would mask
    // the "unset → undefined URL" path.
    delete process.env.UNSUB_TOKEN_SECRET
    delete process.env.NEXTAUTH_URL
    vi.useRealTimers()
  })

  it("throws SendBlockedError when canSendTx returns ok:false (no Message row)", async () => {
    const tx = buildTx({
      contact: { findUnique: vi.fn().mockResolvedValue({
        id: "ct1", tenantId: "tn1", status: "CLIENT", blockedAt: new Date(),
        client: null,
      }) },
    })
    vi.mocked(prisma.$transaction).mockImplementation(async (cb: any) => cb(tx))

    await expect(sendMessage({
      contactId: "ct1", channel: "EMAIL", template: fullTemplate,
      vars: { name: "X" }, toValue: "x@y.com",
    })).rejects.toBeInstanceOf(SendBlockedError)

    expect(tx.message.create).not.toHaveBeenCalled()
  })

  it("renders template before opening the tx (no DB writes from render)", async () => {
    const tx = buildTx()
    vi.mocked(prisma.$transaction).mockImplementation(async (cb: any) => cb(tx))
    vi.mocked(dispatch).mockResolvedValue({ providerMessageId: "em-1", acceptedAt: providerAcceptedAt })

    await sendMessage({
      contactId: "ct1", channel: "EMAIL", template: fullTemplate,
      vars: { name: "Sipho" }, toValue: "x@y.com",
    })

    const createCall = tx.message.create.mock.calls[0]?.[0]
    expect(createCall.data.bodyText).toBe("Hi Sipho")
  })

  it("writes Message with lawfulBasis + basisEvidence + conversationId from eligibility", async () => {
    const tx = buildTx()
    vi.mocked(prisma.$transaction).mockImplementation(async (cb: any) => cb(tx))
    vi.mocked(dispatch).mockResolvedValue({ providerMessageId: "em-1", acceptedAt: providerAcceptedAt })

    await sendMessage({
      contactId: "ct1", channel: "EMAIL", template: fullTemplate,
      vars: { name: "Sipho" }, toValue: "x@y.com",
    })

    const data = tx.message.create.mock.calls[0]?.[0]?.data
    expect(data.lawfulBasis).toBe("SERVICE_COMMS_NCA")
    expect(data.basisEvidence).toMatch(/service template test/)
    expect(data.conversationId).toBe("cv1")
    expect(data.status).toBe("QUEUED")
    expect(data.provider).toBe("SMTP")
  })

  it("starts the initial provider lease after transactional eligibility and conversation work", async () => {
    const beforeEligibility = new Date("2026-07-22T10:00:00.000Z")
    const reservationClock = new Date("2026-07-22T10:07:00.000Z")
    vi.useFakeTimers()
    vi.setSystemTime(beforeEligibility)

    const tx = buildTx({
      conversation: {
        findFirst: vi.fn().mockImplementation(async () => {
          // Model time spent waiting on eligibility locks and earlier DB work.
          vi.setSystemTime(reservationClock)
          return null
        }),
        create: vi.fn().mockResolvedValue({ id: "cv1" }),
      },
    })
    vi.mocked(prisma.$transaction).mockImplementation(async (cb: any) => cb(tx))
    vi.mocked(dispatch).mockResolvedValue({ providerMessageId: "em-fresh-lease", acceptedAt: reservationClock })

    await sendMessage({
      contactId: "ct1", channel: "EMAIL", template: fullTemplate,
      vars: { name: "Sipho" }, toValue: "x@y.com",
    })

    const data = tx.message.create.mock.calls[0]?.[0]?.data
    expect(data.dispatchStartedAt).toEqual(reservationClock)
    expect(data.dispatchStartedAt).not.toEqual(beforeEligibility)
    expect(data.dispatchLeaseExpiresAt.getTime()).toBeGreaterThan(reservationClock.getTime())
  })

  it("reserves a business idempotency key before creating and dispatching", async () => {
    const tx = buildTx()
    vi.mocked(prisma.$transaction).mockImplementation(async (cb: any) => cb(tx))
    vi.mocked(dispatch).mockResolvedValue({ providerMessageId: "em-idempotent", acceptedAt: providerAcceptedAt })

    await sendMessage({
      contactId: "ct1",
      channel: "EMAIL",
      template: fullTemplate,
      vars: { name: "Sipho" },
      toValue: "x@y.com",
      idempotencyKey: "notification:application_submitted:app1:EMAIL",
    })

    expect(tx.$executeRawUnsafe).toHaveBeenCalledWith(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      "tn1:notification:application_submitted:app1:EMAIL",
    )
    expect(tx.message.findUnique).toHaveBeenCalledWith({
      where: {
        tenantId_idempotencyKey: {
          tenantId: "tn1",
          idempotencyKey: "notification:application_submitted:app1:EMAIL",
        },
      },
    })
    expect(tx.message.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        idempotencyKey: "notification:application_submitted:app1:EMAIL",
        dispatchState: "DISPATCHING",
        dispatchToken: expect.any(String),
      }),
    }))
  })

  it("retries a pre-provider Serializable P2034 without duplicating dispatch", async () => {
    const tx = buildTx()
    const conflict = Object.assign(new Error("write conflict"), { code: "P2034" })
    vi.mocked(prisma.$transaction)
      .mockImplementationOnce(async () => { throw conflict })
      .mockImplementation(async (cb: any) => cb(tx))
    vi.mocked(dispatch).mockResolvedValue({ providerMessageId: "em-after-conflict", acceptedAt: providerAcceptedAt })

    const result = await sendMessage({
      contactId: "ct1",
      channel: "EMAIL",
      template: fullTemplate,
      vars: { name: "Sipho" },
      toValue: "x@y.com",
      idempotencyKey: "notification:application_submitted:conflict:EMAIL",
    })

    expect(result.status).toBe("SENT")
    // Failed preparation + successful preparation + terminal completion.
    expect(prisma.$transaction).toHaveBeenCalledTimes(3)
    expect(tx.message.create).toHaveBeenCalledOnce()
    expect(dispatch).toHaveBeenCalledOnce()
  })

  it("returns an existing terminal business reservation without redispatching", async () => {
    const sentAt = new Date("2026-07-19T09:59:58.000Z")
    const existing = {
      id: "msg-existing",
      tenantId: "tn1",
      conversationId: "cv-existing",
      channel: "EMAIL",
      provider: "SMTP",
      templateId: "tpl1",
      status: "SENT",
      sentAt,
      dispatchState: "ACCEPTED",
      dispatchLeaseExpiresAt: null,
      direction: "OUTBOUND",
      subject: "Hello",
      bodyText: "Hi Sipho",
      bodyHtml: null,
      toValue: "x@y.com",
      payloadFingerprint: exactEmailFingerprint(),
    }
    const tx = buildTx({
      conversation: { findFirst: vi.fn().mockResolvedValue({ id: "cv-existing" }) },
      message: { findUnique: vi.fn().mockResolvedValue(existing) },
    })
    vi.mocked(prisma.$transaction).mockImplementation(async (cb: any) => cb(tx))

    const result = await sendMessage({
      contactId: "ct1",
      channel: "EMAIL",
      template: fullTemplate,
      vars: { name: "Sipho" },
      toValue: "x@y.com",
      idempotencyKey: "notification:application_submitted:app1:EMAIL",
    })

    expect(result).toBe(existing)
    expect(prisma.conversation.updateMany).toHaveBeenCalledWith({
      where: {
        id: "cv-existing",
        tenantId: "tn1",
        OR: [{ lastOutboundAt: null }, { lastOutboundAt: { lt: sentAt } }],
      },
      data: { lastOutboundAt: sentAt },
    })
    expect(tx.message.create).not.toHaveBeenCalled()
    expect(dispatch).not.toHaveBeenCalled()
  })

  it("explicitly re-arms the same Message only after a durable definite rejection", async () => {
    const existing = {
      id: "msg-rejected",
      tenantId: "tn1",
      conversationId: "cv-existing",
      channel: "EMAIL",
      provider: "SMTP",
      templateId: "tpl1",
      status: "FAILED_PERMANENT",
      dispatchState: "DEFINITELY_REJECTED",
      dispatchToken: "attempt-old",
      dispatchAttempt: 3,
      retryCount: 5,
      errorClass: "PERMANENT",
      errorMessage: "provider rejected",
      direction: "OUTBOUND",
      subject: "Hello",
      bodyText: "Hi Sipho",
      bodyHtml: null,
      toValue: "x@y.com",
      payloadFingerprint: exactEmailFingerprint(),
    }
    let persisted: any = existing
    const updateMany = vi.fn().mockImplementation(async ({ data }: any) => {
      persisted = { ...persisted, ...data }
      return { count: 1 }
    })
    const tx = buildTx({
      conversation: { findFirst: vi.fn().mockResolvedValue({ id: "cv-existing" }) },
      message: {
        findUnique: vi.fn().mockResolvedValue(existing),
        updateMany,
        findFirst: vi.fn().mockImplementation(async () => persisted),
        findFirstOrThrow: vi.fn().mockImplementation(async () => persisted),
      },
    })
    vi.mocked(prisma.$transaction).mockImplementation(async (cb: any) => cb(tx))
    vi.mocked(dispatch).mockResolvedValue({ providerMessageId: "em-rearmed", acceptedAt: providerAcceptedAt })

    const result = await sendMessage({
      contactId: "ct1",
      channel: "EMAIL",
      template: fullTemplate,
      vars: { name: "Sipho" },
      toValue: "x@y.com",
      idempotencyKey: "automation-wa:rule:loan:1:template:window:1",
      rearmDefinitelyRejected: {
        userId: "admin-1",
        userEmail: "admin@example.test",
        reason: "Provider configuration corrected by an administrator",
      },
    })

    expect(result.status).toBe("SENT")
    expect(tx.message.create).not.toHaveBeenCalled()
    expect(updateMany).toHaveBeenNthCalledWith(1, expect.objectContaining({
      where: expect.objectContaining({
        id: "msg-rejected",
        status: "FAILED_PERMANENT",
        dispatchState: "DEFINITELY_REJECTED",
        dispatchToken: "attempt-old",
      }),
      data: expect.objectContaining({
        status: "QUEUED",
        retryCount: 0,
        dispatchState: "DISPATCHING",
        dispatchAttempt: 4,
        dispatchToken: expect.not.stringContaining("attempt-old"),
      }),
    }))
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: "admin-1",
        userEmail: "admin@example.test",
        action: "MESSAGE_DISPATCH_REARMED",
        entityId: "msg-rejected",
      }),
    })
    expect(dispatch).toHaveBeenCalledWith(
      "EMAIL",
      "SMTP",
      { subject: "Hello", html: null, text: "Hi Sipho" },
      expect.objectContaining({ toValue: "x@y.com" }),
    )
  })

  it("rejects reuse of an idempotency key when payload or recipient changed", async () => {
    const existing = {
      id: "msg-existing-conflict",
      tenantId: "tn1",
      conversationId: "cv-existing",
      direction: "OUTBOUND",
      channel: "EMAIL",
      provider: "SMTP",
      templateId: "tpl1",
      status: "SENT",
      dispatchState: "ACCEPTED",
      subject: "Hello",
      bodyText: "Hi Original",
      bodyHtml: null,
      toValue: "original@example.test",
      payloadFingerprint: exactEmailFingerprint(),
    }
    const tx = buildTx({
      conversation: { findFirst: vi.fn().mockResolvedValue({ id: "cv-existing" }) },
      message: { findUnique: vi.fn().mockResolvedValue(existing) },
    })
    vi.mocked(prisma.$transaction).mockImplementation(async (cb: any) => cb(tx))

    await expect(sendMessage({
      contactId: "ct1",
      channel: "EMAIL",
      template: fullTemplate,
      vars: { name: "Changed" },
      toValue: "changed@example.test",
      idempotencyKey: "notification:application_submitted:app1:EMAIL",
    })).rejects.toBeInstanceOf(MessageIdempotencyConflictError)

    expect(tx.message.create).not.toHaveBeenCalled()
    expect(dispatch).not.toHaveBeenCalled()
  })

  it("never re-arms an accepted or otherwise uncertain occurrence", async () => {
    const accepted = {
      id: "msg-accepted",
      tenantId: "tn1",
      conversationId: "cv-existing",
      status: "QUEUED",
      dispatchState: "ACCEPTED",
      dispatchLeaseExpiresAt: null,
      direction: "OUTBOUND",
      channel: "EMAIL",
      provider: "SMTP",
      templateId: "tpl1",
      subject: "Hello",
      bodyText: "Hi Sipho",
      bodyHtml: null,
      toValue: "x@y.com",
      payloadFingerprint: exactEmailFingerprint(),
    }
    const tx = buildTx({
      conversation: { findFirst: vi.fn().mockResolvedValue({ id: "cv-existing" }) },
      message: { findUnique: vi.fn().mockResolvedValue(accepted) },
    })
    vi.mocked(prisma.$transaction).mockImplementation(async (cb: any) => cb(tx))

    await expect(sendMessage({
      contactId: "ct1",
      channel: "EMAIL",
      template: fullTemplate,
      vars: { name: "Sipho" },
      toValue: "x@y.com",
      idempotencyKey: "automation-wa:rule:loan:1:template:window:1",
      rearmDefinitelyRejected: {
        userId: "admin-1",
        userEmail: "admin@example.test",
        reason: "Attempting an unsafe replay must remain blocked",
      },
    })).rejects.toBeInstanceOf(MessageReconciliationRequiredError)

    expect(tx.message.updateMany).not.toHaveBeenCalled()
    expect(dispatch).not.toHaveBeenCalled()
  })

  it("does not dispatch when the atomic re-arm audit cannot be written", async () => {
    const rejected = {
      id: "msg-rejected-audit",
      tenantId: "tn1",
      conversationId: "cv-existing",
      channel: "EMAIL",
      provider: "SMTP",
      templateId: "tpl1",
      status: "FAILED_PERMANENT",
      dispatchState: "DEFINITELY_REJECTED",
      dispatchToken: "attempt-old",
      dispatchAttempt: 1,
      retryCount: 1,
      errorClass: "PERMANENT",
      errorMessage: "provider rejected",
      direction: "OUTBOUND",
      subject: "Hello",
      bodyText: "Hi Sipho",
      bodyHtml: null,
      toValue: "x@y.com",
      payloadFingerprint: exactEmailFingerprint(),
    }
    const tx = buildTx({
      conversation: { findFirst: vi.fn().mockResolvedValue({ id: "cv-existing" }) },
      message: { findUnique: vi.fn().mockResolvedValue(rejected) },
      auditLog: { create: vi.fn().mockRejectedValue(new Error("audit unavailable")) },
    })
    vi.mocked(prisma.$transaction).mockImplementation(async (cb: any) => cb(tx))

    await expect(sendMessage({
      contactId: "ct1",
      channel: "EMAIL",
      template: fullTemplate,
      vars: { name: "Sipho" },
      toValue: "x@y.com",
      idempotencyKey: "automation-wa:rule:loan:1:template:window:1",
      rearmDefinitelyRejected: {
        userId: "admin-1",
        userEmail: "admin@example.test",
        reason: "Provider configuration corrected by an administrator",
      },
    })).rejects.toThrow("audit unavailable")

    expect(dispatch).not.toHaveBeenCalled()
  })

  it("refuses a re-arm request that is not bound to a durable business key", async () => {
    await expect(sendMessage({
      contactId: "ct1",
      channel: "EMAIL",
      template: fullTemplate,
      vars: { name: "Sipho" },
      toValue: "x@y.com",
      rearmDefinitelyRejected: {
        userId: "admin-1",
        userEmail: "admin@example.test",
        reason: "Provider configuration corrected by an administrator",
      },
    })).rejects.toThrow("durable idempotency key is required")

    expect(prisma.$transaction).not.toHaveBeenCalled()
    expect(dispatch).not.toHaveBeenCalled()
  })

  it("fails closed when an explicit re-arm cannot find its original reservation", async () => {
    const tx = buildTx({ message: { findUnique: vi.fn().mockResolvedValue(null) } })
    vi.mocked(prisma.$transaction).mockImplementation(async (cb: any) => cb(tx))

    await expect(sendMessage({
      contactId: "ct1",
      channel: "EMAIL",
      template: fullTemplate,
      vars: { name: "Sipho" },
      toValue: "x@y.com",
      idempotencyKey: "automation-wa:rule:loan:1:template:old-window",
      rearmDefinitelyRejected: {
        userId: "admin-1",
        userEmail: "admin@example.test",
        reason: "Manual replay of the original failed automation occurrence",
      },
    })).rejects.toThrow("no existing message reservation matches this occurrence")

    expect(tx.message.create).not.toHaveBeenCalled()
    expect(tx.auditLog.create).not.toHaveBeenCalled()
    expect(dispatch).not.toHaveBeenCalled()
  })

  it("returns the existing record as reconciliation-required instead of recreating an ambiguous event", async () => {
    const existing = {
      id: "msg-ambiguous",
      tenantId: "tn1",
      conversationId: "cv-existing",
      status: "QUEUED",
      dispatchState: "AMBIGUOUS",
      dispatchLeaseExpiresAt: null,
      direction: "OUTBOUND",
      channel: "EMAIL",
      provider: "SMTP",
      templateId: "tpl1",
      subject: "Hello",
      bodyText: "Hi Sipho",
      bodyHtml: null,
      toValue: "x@y.com",
      payloadFingerprint: exactEmailFingerprint(),
    }
    const tx = buildTx({
      conversation: { findFirst: vi.fn().mockResolvedValue({ id: "cv-existing" }) },
      message: { findUnique: vi.fn().mockResolvedValue(existing) },
    })
    vi.mocked(prisma.$transaction).mockImplementation(async (cb: any) => cb(tx))

    await expect(sendMessage({
      contactId: "ct1",
      channel: "EMAIL",
      template: fullTemplate,
      vars: { name: "Sipho" },
      toValue: "x@y.com",
      idempotencyKey: "notification:application_submitted:app1:EMAIL",
    })).rejects.toMatchObject({
      name: "MessageReconciliationRequiredError",
      messageRecord: existing,
    })
    expect(tx.message.create).not.toHaveBeenCalled()
    expect(dispatch).not.toHaveBeenCalled()
  })

  it("transitions Message to SENT on dispatch success", async () => {
    const tx = buildTx()
    vi.mocked(prisma.$transaction).mockImplementation(async (cb: any) => cb(tx))
    vi.mocked(dispatch).mockResolvedValue({ providerMessageId: "em-1", acceptedAt: providerAcceptedAt })
    vi.mocked(prisma.message.update).mockResolvedValue({} as any)

    await sendMessage({
      contactId: "ct1", channel: "EMAIL", template: fullTemplate,
      vars: { name: "X" }, toValue: "x@y.com",
    })

    // Provider completion CAS + audit are one transaction.
    expect(tx.message.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "msg1",
          tenantId: "tn1",
          status: "QUEUED",
          dispatchState: "DISPATCHING",
          dispatchToken: expect.any(String),
        }),
        data: expect.objectContaining({
          status: "SENT",
          sentAt: providerAcceptedAt,
          providerMessageId: "em-1",
          dispatchState: "ACCEPTED",
          dispatchProviderMessageId: "em-1",
        }),
      })
    )
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: "MESSAGE_SENT", entityId: "msg1" }),
    })
  })

  it("persists dry-run dispatch as SIMULATED without a sent timestamp", async () => {
    const tx = buildTx()
    vi.mocked(prisma.$transaction).mockImplementation(async (cb: any) => cb(tx))
    vi.mocked(dispatch).mockResolvedValue({
      simulationReceiptId: "dry-run-1",
      simulated: true,
    })
    vi.mocked(prisma.message.update).mockResolvedValue({ status: "SIMULATED" } as any)

    const result = await sendMessage({
      contactId: "ct1", channel: "SMS", template: fullTemplate,
      vars: { name: "X" }, toValue: "27821234567",
    })

    expect(result.status).toBe("SIMULATED")
    expect(tx.message.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: "msg1", dispatchState: "DISPATCHING" }),
      data: expect.objectContaining({
        status: "SIMULATED",
        sentAt: null,
        providerMessageId: null,
        dispatchState: "SIMULATED",
        dispatchProviderMessageId: null,
        dispatchProviderAcceptedAt: null,
        simulationReceiptId: "dry-run-1",
      }),
    }))
    expect(tx.auditLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      action: "MESSAGE_SIMULATED",
      newValue: expect.objectContaining({ simulated: true, providerAcceptedAt: null }),
    }) })
  })

  it("signals statutory callers only after the Message commit and immediately before provider dispatch", async () => {
    const tx = buildTx()
    let transactionCommitted = false
    const phases: string[] = []
    vi.mocked(prisma.$transaction).mockImplementation(async (cb: any) => {
      const result = await cb(tx)
      transactionCommitted = true
      return result
    })
    const onProviderDispatchStart = vi.fn(() => {
      expect(transactionCommitted).toBe(true)
      phases.push("provider-boundary")
    })
    vi.mocked(dispatch).mockImplementation(async (_channel, _provider, _rendered, dispatchOpts) => {
      phases.push("adapter-entered")
      dispatchOpts.onProviderDispatchStart?.()
      phases.push("provider-call")
      expect(onProviderDispatchStart).toHaveBeenCalledOnce()
      return { providerMessageId: "em-1", acceptedAt: providerAcceptedAt }
    })
    vi.mocked(prisma.message.update).mockResolvedValue({} as any)

    await sendMessage({
      contactId: "ct1",
      channel: "EMAIL",
      template: fullTemplate,
      vars: { name: "X" },
      toValue: "x@y.com",
      onProviderDispatchStart,
    })

    expect(phases).toEqual(["adapter-entered", "provider-boundary", "provider-call"])
  })

  it("transitions Message to RETRYING on TRANSIENT dispatch error (first attempt)", async () => {
    const tx = buildTx()
    vi.mocked(prisma.$transaction).mockImplementation(async (cb: any) => cb(tx))
    vi.mocked(dispatch).mockRejectedValue(
      new ProviderDispatchError("502 Bad Gateway", "DEFINITELY_REJECTED"),
    )
    vi.mocked(prisma.message.update).mockResolvedValue({} as any)

    const result = await sendMessage({
      contactId: "ct1", channel: "SMS", template: fullTemplate,
      vars: { name: "X" }, toValue: "27821234567",
    })

    expect(result).toMatchObject({ id: "msg1", status: "RETRYING" })

    expect(tx.message.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "msg1", dispatchState: "DISPATCHING" }),
        data: expect.objectContaining({
          status: "RETRYING",
          retryCount: 1,
          nextRetryAt: expect.any(Date),
          errorClass: "TRANSIENT",
          dispatchState: "DEFINITELY_REJECTED",
        }),
      })
    )
  })

  it("holds an ambiguous initial dispatch for reconciliation and never schedules a retry", async () => {
    const tx = buildTx()
    vi.mocked(prisma.$transaction).mockImplementation(async (cb: any) => cb(tx))
    vi.mocked(dispatch).mockRejectedValue(new Error("provider response timed out"))
    vi.mocked(prisma.message.update).mockResolvedValue({} as any)

    await expect(sendMessage({
      contactId: "ct1", channel: "EMAIL", template: fullTemplate,
      vars: { name: "X" }, toValue: "x@y.com",
    })).rejects.toMatchObject({
      name: "MessageReconciliationRequiredError",
      messageRecord: expect.objectContaining({ id: "msg1", dispatchState: "AMBIGUOUS" }),
    })

    expect(tx.message.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: "msg1", dispatchState: "DISPATCHING" }),
      data: expect.objectContaining({
        nextRetryAt: null,
        errorClass: "RETRY_DISPATCH_CLAIMED_MANUAL_RECONCILIATION",
        dispatchState: "AMBIGUOUS",
      }),
    }))
    expect(tx.message.updateMany).not.toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "RETRYING" }),
    }))
    expect(tx.auditLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      action: "MESSAGE_DISPATCH_FAILED_RECONCILIATION_REQUIRED",
      newValue: expect.objectContaining({
        providerOutcome: "AMBIGUOUS",
        automaticRetrySuppressed: true,
      }),
    }) })
  })

  it.each([
    { providerLabel: "BulkSMS", channel: "SMS", toValue: "27821234567", classify: bulkSmsHttpFailureOutcome, status: 408 },
    { providerLabel: "BulkSMS", channel: "SMS", toValue: "27821234567", classify: bulkSmsHttpFailureOutcome, status: 409 },
    { providerLabel: "WhatsApp", channel: "WHATSAPP", toValue: "27821234567", classify: waHttpFailureOutcome, status: 408 },
    { providerLabel: "WhatsApp", channel: "WHATSAPP", toValue: "27821234567", classify: waHttpFailureOutcome, status: 409 },
    { providerLabel: "MS Graph", channel: "EMAIL", toValue: "x@y.com", classify: graphHttpFailureOutcome, status: 408 },
    { providerLabel: "MS Graph", channel: "EMAIL", toValue: "x@y.com", classify: graphHttpFailureOutcome, status: 409 },
  ] as const)("never retries an ambiguous $providerLabel HTTP $status", async ({
    providerLabel,
    channel,
    toValue,
    classify,
    status,
  }) => {
    const tx = buildTx()
    vi.mocked(prisma.$transaction).mockImplementation(async (cb: any) => cb(tx))
    if (channel === "EMAIL") {
      vi.mocked(prisma.emailConfig.findUnique).mockResolvedValue({
        active: true,
        provider: "MSGRAPH",
      } as any)
    }
    vi.mocked(dispatch).mockRejectedValue(
      new ProviderDispatchError(
        `${providerLabel} returned HTTP ${status}`,
        classify(status),
      ),
    )
    vi.mocked(prisma.message.update).mockResolvedValue({} as any)

    await expect(sendMessage({
      contactId: "ct1",
      channel,
      template: fullTemplate,
      vars: { name: "X" },
      toValue,
    })).rejects.toBeInstanceOf(MessageReconciliationRequiredError)

    expect(tx.message.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ status: "QUEUED" }),
      data: expect.objectContaining({
        nextRetryAt: null,
        dispatchState: "AMBIGUOUS",
      }),
    }))
    expect(tx.message.updateMany).not.toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "RETRYING" }),
    }))
  })

  it.each([
    ["SMS", "27821234567", "SMS provider"],
    ["WHATSAPP", "27821234567", "WhatsApp provider"],
  ] as const)("never terminalizes %s as SENT when provider success lacks an id", async (channel, toValue, providerLabel) => {
    const tx = buildTx()
    vi.mocked(prisma.$transaction).mockImplementation(async (cb: any) => cb(tx))
    vi.mocked(dispatch).mockRejectedValue(
      new ProviderDispatchError(
        `${providerLabel} returned success without a provider message id`,
        "AMBIGUOUS",
      ),
    )
    vi.mocked(prisma.message.update).mockResolvedValue({} as any)

    await expect(sendMessage({
      contactId: "ct1",
      channel,
      template: fullTemplate,
      vars: { name: "X" },
      toValue,
    })).rejects.toMatchObject({
      name: "MessageReconciliationRequiredError",
      messageRecord: expect.objectContaining({ id: "msg1", dispatchState: "AMBIGUOUS" }),
    })

    expect(tx.message.updateMany).not.toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "SENT" }),
    }))
    expect(tx.message.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        nextRetryAt: null,
        errorClass: "RETRY_DISPATCH_CLAIMED_MANUAL_RECONCILIATION",
        dispatchState: "AMBIGUOUS",
      }),
    }))
    expect(tx.auditLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      action: "MESSAGE_DISPATCH_FAILED_RECONCILIATION_REQUIRED",
      newValue: expect.objectContaining({
        providerOutcome: "AMBIGUOUS",
        automaticRetrySuppressed: true,
      }),
    }) })
  })

  it("never schedules a generic retry when a statutory caller owns reconciliation", async () => {
    const tx = buildTx()
    vi.mocked(prisma.$transaction).mockImplementation(async (cb: any) => cb(tx))
    vi.mocked(dispatch).mockRejectedValue(new Error("502 Bad Gateway"))
    vi.mocked(prisma.message.update).mockResolvedValue({} as any)

    await expect(sendMessage({
      contactId: "ct1",
      channel: "EMAIL",
      template: fullTemplate,
      vars: { name: "X" },
      toValue: "x@y.com",
      attachments: [{ filename: "operative.pdf", content: Buffer.from("pdf"), contentType: "application/pdf" }],
      automaticRetry: false,
    })).rejects.toThrow("502 Bad Gateway")

    expect(tx.message.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: "msg1", dispatchState: "DISPATCHING" }),
      data: expect.objectContaining({
        status: "FAILED_PERMANENT",
        nextRetryAt: null,
        errorClass: "TRANSIENT_REQUIRES_RECONCILIATION",
        dispatchState: "AMBIGUOUS",
      }),
    }))
    expect(tx.auditLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      action: "MESSAGE_DISPATCH_FAILED_RECONCILIATION_REQUIRED",
      newValue: expect.objectContaining({ automaticRetrySuppressed: true }),
    }) })
  })

  it("records a definite statutory provider rejection as known not sent", async () => {
    const tx = buildTx()
    vi.mocked(prisma.$transaction).mockImplementation(async (cb: any) => cb(tx))
    vi.mocked(dispatch).mockRejectedValue(
      new ProviderDispatchError("recipient rejected", "DEFINITELY_REJECTED"),
    )
    vi.mocked(prisma.message.update).mockResolvedValue({} as any)

    await expect(sendMessage({
      contactId: "ct1",
      channel: "EMAIL",
      template: fullTemplate,
      vars: { name: "X" },
      toValue: "x@y.com",
      automaticRetry: false,
    })).rejects.toThrow("recipient rejected")

    expect(tx.message.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: "FAILED_PERMANENT",
        errorClass: expect.stringMatching(/_KNOWN_NOT_SENT$/),
        dispatchState: "DEFINITELY_REJECTED",
      }),
    }))
    expect(tx.auditLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      action: "MESSAGE_DISPATCH_KNOWN_NOT_SENT",
      newValue: expect.objectContaining({ providerOutcome: "DEFINITELY_REJECTED" }),
    }) })
  })

  it("transitions to FAILED_PERMANENT on PERMANENT dispatch error", async () => {
    const tx = buildTx()
    vi.mocked(prisma.$transaction).mockImplementation(async (cb: any) => cb(tx))
    vi.mocked(dispatch).mockRejectedValue(
      new ProviderDispatchError(
        "BulkSMS error code 1001: invalid number",
        "DEFINITELY_REJECTED",
      ),
    )
    vi.mocked(prisma.message.update).mockResolvedValue({} as any)

    const result = await sendMessage({
      contactId: "ct1", channel: "SMS", template: fullTemplate,
      vars: { name: "X" }, toValue: "bogus",
    })

    expect(result).toMatchObject({ id: "msg1", status: "FAILED_PERMANENT" })

    expect(tx.message.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "msg1", dispatchState: "DISPATCHING" }),
        data: expect.objectContaining({
          status: "FAILED_PERMANENT",
          errorClass: "PERMANENT",
          dispatchState: "DEFINITELY_REJECTED",
        }),
      })
    )
  })

  it("durably holds the real provider id when both SENT transactions fail", async () => {
    const tx = buildTx()
    vi.mocked(prisma.$transaction).mockImplementation(async (cb: any) => cb(tx))
    vi.mocked(dispatch).mockResolvedValueOnce({ providerMessageId: "prov-1", acceptedAt: providerAcceptedAt })
    tx.message.updateMany
      .mockRejectedValueOnce(new Error("DB unavailable"))
      .mockRejectedValueOnce(new Error("DB unavailable retry"))
      .mockResolvedValueOnce({ count: 1 } as any)
    tx.message.findFirstOrThrow.mockResolvedValue({
      id: "msg1",
      conversationId: "cv1",
      status: "QUEUED",
      dispatchState: "ACCEPTED",
      dispatchProviderMessageId: "prov-1",
    } as any)

    const attempt = sendMessage({
      contactId: "ct1", channel: "EMAIL", template: fullTemplate,
      vars: { name: "X" }, toValue: "x@y.com",
    })

    await expect(attempt).rejects.toMatchObject({
      name: "MessageReconciliationRequiredError",
      messageRecord: expect.objectContaining({
        id: "msg1",
        dispatchState: "ACCEPTED",
        dispatchProviderMessageId: "prov-1",
      }),
    })

    // Critical: must NOT emit MESSAGE_FAILED after provider acceptance.
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "MESSAGE_SENT_DB_WRITE_FAILED",
        newValue: expect.objectContaining({
          providerMessageId: "prov-1",
          dispatchState: "ACCEPTED",
          automaticReplayDisabled: true,
        }),
      }),
    })
    expect(tx.message.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: "msg1", status: "QUEUED", dispatchState: "DISPATCHING" }),
      data: expect.objectContaining({
        nextRetryAt: null,
        errorClass: "RETRY_DISPATCH_CLAIMED_MANUAL_RECONCILIATION",
        dispatchState: "ACCEPTED",
        dispatchProviderMessageId: "prov-1",
      }),
    }))
  })

  it("durably holds a simulated outcome when both terminal transactions fail", async () => {
    const tx = buildTx()
    vi.mocked(prisma.$transaction).mockImplementation(async (cb: any) => cb(tx))
    vi.mocked(dispatch).mockResolvedValueOnce({
      simulationReceiptId: "dry-run-1",
      simulated: true,
    })
    tx.message.updateMany
      .mockRejectedValueOnce(new Error("DB unavailable"))
      .mockRejectedValueOnce(new Error("DB unavailable retry"))
      .mockResolvedValueOnce({ count: 1 } as any)
    tx.message.findFirstOrThrow.mockResolvedValue({
      id: "msg1",
      conversationId: "cv1",
      status: "QUEUED",
      dispatchState: "SIMULATED",
      dispatchProviderMessageId: null,
      simulationReceiptId: "dry-run-1",
    } as any)

    const attempt = sendMessage({
      contactId: "ct1", channel: "SMS", template: fullTemplate,
      vars: { name: "X" }, toValue: "27821234567",
    })

    await expect(attempt).rejects.toMatchObject({
      name: "MessageReconciliationRequiredError",
      messageRecord: expect.objectContaining({ dispatchState: "SIMULATED" }),
    })

    expect(tx.auditLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      action: "MESSAGE_SIMULATED_DB_WRITE_FAILED",
      newValue: expect.objectContaining({
        dispatchState: "SIMULATED",
        providerMessageId: null,
        providerAcceptedAt: null,
        simulationReceiptId: "dry-run-1",
      }),
    }) })
  })

  it("writes emergency append-only evidence when terminal, recovery, and hold writes all fail", async () => {
    const tx = buildTx()
    vi.mocked(prisma.$transaction).mockImplementation(async (cb: any) => cb(tx))
    vi.mocked(dispatch).mockResolvedValueOnce({
      providerMessageId: "provider-known-1",
      acceptedAt: providerAcceptedAt,
    })
    tx.message.updateMany
      .mockRejectedValueOnce(new Error("terminal write unavailable"))
      .mockRejectedValueOnce(new Error("recovery write unavailable"))
      .mockRejectedValueOnce(new Error("hold write unavailable"))

    const error = await sendMessage({
      contactId: "ct1",
      channel: "EMAIL",
      template: fullTemplate,
      vars: { name: "X" },
      toValue: "x@y.com",
    }).catch((caught) => caught)

    expect(error).toMatchObject({
      name: "KnownDispatchPersistenceError",
      outcome: "PROVIDER_ACCEPTED",
      providerMessageId: "provider-known-1",
      providerAcceptedAt,
      holdWriteError: expect.objectContaining({ message: "hold write unavailable" }),
      evidenceAuditWriteError: undefined,
    })
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "MESSAGE_DISPATCH_EVIDENCE_RECOVERED",
        entityId: "msg1",
        newValue: expect.objectContaining({
          outcome: "PROVIDER_ACCEPTED",
          providerMessageId: "provider-known-1",
          providerAcceptedAt: providerAcceptedAt.toISOString(),
          terminalWriteError: "Error: terminal write unavailable",
          recoveryWriteError: "Error: recovery write unavailable",
          holdWriteError: "Error: hold write unavailable",
          automaticReplayDisabled: true,
        }),
      }),
    })
  })

  it("retains the emergency-audit failure alongside known provider evidence", async () => {
    const tx = buildTx()
    vi.mocked(prisma.$transaction).mockImplementation(async (cb: any) => cb(tx))
    vi.mocked(dispatch).mockResolvedValueOnce({
      simulationReceiptId: "dry-run-known",
      simulated: true,
    })
    tx.message.updateMany
      .mockRejectedValueOnce(new Error("terminal write unavailable"))
      .mockRejectedValueOnce(new Error("recovery write unavailable"))
      .mockRejectedValueOnce(new Error("hold write unavailable"))
    vi.mocked(prisma.auditLog.create).mockRejectedValueOnce(new Error("audit unavailable"))

    const error = await sendMessage({
      contactId: "ct1",
      channel: "SMS",
      template: fullTemplate,
      vars: { name: "X" },
      toValue: "27821234567",
    }).catch((caught) => caught)

    expect(error).toMatchObject({
      name: "KnownDispatchPersistenceError",
      outcome: "SIMULATED",
      simulationReceiptId: "dry-run-known",
      holdWriteError: expect.objectContaining({ message: "hold write unavailable" }),
      evidenceAuditWriteError: expect.objectContaining({ message: "audit unavailable" }),
    })
  })

  it.each([
    [{ providerMessageId: "provider-recovered", acceptedAt: providerAcceptedAt }, "SENT", providerAcceptedAt],
    [{ simulationReceiptId: "dry-run-recovered", simulated: true as const }, "SIMULATED", null],
  ])("returns the recovered terminal Message after the first status write fails", async (dispatchOutcome, status, sentAt) => {
    const tx = buildTx()
    vi.mocked(prisma.$transaction).mockImplementation(async (cb: any) => cb(tx))
    vi.mocked(dispatch).mockResolvedValueOnce(dispatchOutcome)
    tx.message.updateMany
      .mockRejectedValueOnce(new Error("first write unavailable"))
      .mockResolvedValueOnce({ count: 1 } as any)
    tx.message.findFirstOrThrow.mockResolvedValue({ id: "msg1", status, sentAt } as any)
    const simulated = "simulated" in dispatchOutcome && dispatchOutcome.simulated === true

    const result = await sendMessage({
      contactId: "ct1",
      channel: simulated ? "SMS" : "EMAIL",
      template: fullTemplate,
      vars: { name: "X" },
      toValue: simulated ? "27821234567" : "x@y.com",
    })

    expect(result).toMatchObject({ id: "msg1", status, sentAt })
    expect(tx.message.updateMany).toHaveBeenCalledTimes(2)
    expect(tx.auditLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      action: status === "SIMULATED" ? "MESSAGE_SIMULATED" : "MESSAGE_SENT",
      newValue: expect.objectContaining({ postDispatchRecovery: true }),
    }) })
  })

  it("emits MESSAGE_SENT on success and MESSAGE_FAILED on PERMANENT error", async () => {
    const tx = buildTx()
    vi.mocked(prisma.$transaction).mockImplementation(async (cb: any) => cb(tx))
    vi.mocked(dispatch).mockResolvedValueOnce({ providerMessageId: "em-1", acceptedAt: providerAcceptedAt })

    await sendMessage({
      contactId: "ct1", channel: "EMAIL", template: fullTemplate,
      vars: { name: "X" }, toValue: "x@y.com",
    })
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: "MESSAGE_SENT", entityId: "msg1" }),
    })

    tx.auditLog.create.mockClear()
    // PERMANENT error → MESSAGE_FAILED audit + FAILED_PERMANENT status
    vi.mocked(dispatch).mockRejectedValueOnce(
      new ProviderDispatchError(
        "BulkSMS error code 1001: invalid number",
        "DEFINITELY_REJECTED",
      ),
    )

    await sendMessage({
      contactId: "ct1", channel: "SMS", template: fullTemplate,
      vars: { name: "X" }, toValue: "27821234567",
    })
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: "MESSAGE_FAILED", entityId: "msg1" }),
    })
  })

  it("does NOT emit MESSAGE_FAILED on TRANSIENT error (still in retry envelope)", async () => {
    const tx = buildTx()
    vi.mocked(prisma.$transaction).mockImplementation(async (cb: any) => cb(tx))
    vi.mocked(dispatch).mockRejectedValue(
      new ProviderDispatchError("502 Bad Gateway", "DEFINITELY_REJECTED"),
    )
    vi.mocked(prisma.message.update).mockResolvedValue({} as any)

    await sendMessage({
      contactId: "ct1", channel: "SMS", template: fullTemplate,
      vars: { name: "X" }, toValue: "27821234567",
    })

    // No MESSAGE_FAILED audit on TRANSIENT — the row is still retryable;
    // ops would think we gave up if we wrote MESSAGE_FAILED here.
    expect(tx.auditLog.create).not.toHaveBeenCalledWith({
      data: expect.objectContaining({ action: "MESSAGE_FAILED" }),
    })
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: "MESSAGE_RETRY_SCHEDULED" }),
    })
  })

  it("passes listUnsubscribeUrl to dispatch for EMAIL channel", async () => {
    process.env.UNSUB_TOKEN_SECRET = "test-secret"
    process.env.NEXTAUTH_URL = "https://test.example"
    const tx = buildTx()
    vi.mocked(prisma.$transaction).mockImplementation(async (cb: any) => cb(tx))
    vi.mocked(dispatch).mockResolvedValue({ providerMessageId: "em-1", acceptedAt: providerAcceptedAt })
    vi.mocked(prisma.message.update).mockResolvedValue({} as any)

    await sendMessage({
      contactId: "ct1", channel: "EMAIL", template: fullTemplate,
      vars: { name: "X" }, toValue: "x@y.com",
    })

    const dispatchOpts = vi.mocked(dispatch).mock.calls[0][3]
    expect(typeof dispatchOpts.listUnsubscribeUrl).toBe("string")
    expect(dispatchOpts.listUnsubscribeUrl).toMatch(/^https:\/\/test\.example\/api\/messaging\/unsubscribe\?uns=/)
  })

  it("does NOT pass listUnsubscribeUrl for non-EMAIL channels (SMS)", async () => {
    process.env.UNSUB_TOKEN_SECRET = "test-secret"
    const smsTx = buildTx({
      message: {
        create: vi.fn().mockResolvedValue({
          id: "msg1", tenantId: "tn1", conversationId: "cv1",
          channel: "SMS", direction: "OUTBOUND", provider: "BULKSMS",
          status: "QUEUED", lawfulBasis: "SERVICE_COMMS_NCA",
        }),
        update: vi.fn().mockResolvedValue({}),
      },
    })
    vi.mocked(prisma.$transaction).mockImplementation(async (cb: any) => cb(smsTx))
    vi.mocked(dispatch).mockResolvedValue({ providerMessageId: "sms-1", acceptedAt: providerAcceptedAt })
    vi.mocked(prisma.message.update).mockResolvedValue({} as any)

    await sendMessage({
      contactId: "ct1", channel: "SMS", template: { ...fullTemplate, category: "SERVICE" } as any,
      vars: { name: "X" }, toValue: "+27821234567",
    })

    const dispatchOpts = vi.mocked(dispatch).mock.calls[0][3]
    expect(dispatchOpts.listUnsubscribeUrl).toBeUndefined()
  })

  it("omits listUnsubscribeUrl when UNSUB_TOKEN_SECRET is not configured", async () => {
    // No process.env.UNSUB_TOKEN_SECRET — buildListUnsubscribeUrl returns
    // undefined so the send still goes through cleanly without a broken
    // unsub link.
    const tx = buildTx()
    vi.mocked(prisma.$transaction).mockImplementation(async (cb: any) => cb(tx))
    vi.mocked(dispatch).mockResolvedValue({ providerMessageId: "em-2", acceptedAt: providerAcceptedAt })
    vi.mocked(prisma.message.update).mockResolvedValue({} as any)

    await sendMessage({
      contactId: "ct1", channel: "EMAIL", template: fullTemplate,
      vars: { name: "X" }, toValue: "x@y.com",
    })

    const dispatchOpts = vi.mocked(dispatch).mock.calls[0][3]
    expect(dispatchOpts.listUnsubscribeUrl).toBeUndefined()
  })

  it("omits listUnsubscribeUrl for statutoryOverride templates (NCA s.129 etc.)", async () => {
    // Statutory mail must not offer an unsubscribe — the recipient cannot
    // lawfully opt out of a notice the law requires us to send. Suppress
    // at source even when UNSUB_TOKEN_SECRET is set and the channel is EMAIL.
    process.env.UNSUB_TOKEN_SECRET = "test-secret"
    process.env.NEXTAUTH_URL = "https://test.example"
    const tx = buildTx()
    vi.mocked(prisma.$transaction).mockImplementation(async (cb: any) => cb(tx))
    vi.mocked(dispatch).mockResolvedValue({ providerMessageId: "em-stat", acceptedAt: providerAcceptedAt })
    vi.mocked(prisma.message.update).mockResolvedValue({} as any)

    const statutoryTemplate = { ...fullTemplate, statutoryOverride: true }
    await sendMessage({
      contactId: "ct1", channel: "EMAIL", template: statutoryTemplate as typeof fullTemplate,
      vars: { name: "X" }, toValue: "x@y.com",
    })

    const dispatchOpts = vi.mocked(dispatch).mock.calls[0][3]
    expect(dispatchOpts.listUnsubscribeUrl).toBeUndefined()
  })

  it("passes contactId + a WABA template ref to dispatch for WA_CLOUD", async () => {
    vi.mocked(prisma.commsSettings.findUnique).mockResolvedValue({ waProvider: "WA_CLOUD" } as never)
    const tx = buildTx()
    vi.mocked(prisma.$transaction).mockImplementation(async (cb: any) => cb(tx))
    vi.mocked(dispatch).mockResolvedValue({ providerMessageId: "wamid.T", acceptedAt: new Date() })
    vi.mocked(prisma.message.update).mockResolvedValue({} as any)

    await sendMessage({
      contactId: "ct1",
      channel: "WHATSAPP",
      template: { ...fullTemplate, wabaTemplateName: "review_ask", language: "en", bodyTemplate: "Hi {{name}}", providerStatus: "APPROVED" },
      vars: { name: "Thabo" },
      toValue: "27821234567",
    })

    expect(dispatch).toHaveBeenCalledWith(
      "WHATSAPP",
      "WA_CLOUD",
      expect.anything(),
      expect.objectContaining({
        contactId: "ct1",
        waTemplate: expect.objectContaining({ name: "review_ask", language: "en", providerStatus: "APPROVED" }),
      }),
    )
  })

  it("does not build a WABA template ref when a required var is missing (no blank fields)", async () => {
    // The missing placeholder lives in headerContent rather than bodyTemplate:
    // renderTemplate() unconditionally substitutes bodyTemplate into `html` for
    // every channel and throws on any unmet var, which would abort the send
    // before dispatch is ever reached — a pre-existing render.ts behavior out
    // of scope for this task. headerContent is never touched by renderTemplate,
    // so this isolates the WABA-ref guard without tripping that unrelated path.
    vi.mocked(prisma.commsSettings.findUnique).mockResolvedValue({ waProvider: "WA_CLOUD" } as never)
    const tx = buildTx()
    vi.mocked(prisma.$transaction).mockImplementation(async (cb: any) => cb(tx))
    vi.mocked(dispatch).mockResolvedValue({ providerMessageId: "wamid.T", acceptedAt: new Date() })
    vi.mocked(prisma.message.update).mockResolvedValue({} as any)

    await sendMessage({
      contactId: "ct1", channel: "WHATSAPP",
      template: {
        ...fullTemplate,
        wabaTemplateName: "review_ask",
        language: "en",
        bodyTemplate: "Hi {{name}}",
        headerContent: "Ref {{ref}}",
        providerStatus: "APPROVED",
      },
      vars: { name: "Thabo" }, // {{ref}} missing (only referenced by headerContent)
      toValue: "27821234567",
    })

    expect(dispatch).toHaveBeenCalledWith("WHATSAPP", "WA_CLOUD", expect.anything(),
      expect.objectContaining({ contactId: "ct1", waTemplate: undefined }))
  })

  it("carries a URL button's variable through to the template ref", async () => {
    vi.mocked(prisma.commsSettings.findUnique).mockResolvedValue({ waProvider: "WA_CLOUD" } as never)
    const tx = buildTx()
    vi.mocked(prisma.$transaction).mockImplementation(async (cb: any) => cb(tx))
    vi.mocked(dispatch).mockResolvedValue({ providerMessageId: "wamid.T", acceptedAt: new Date() })
    vi.mocked(prisma.message.update).mockResolvedValue({} as any)

    await sendMessage({
      contactId: "ct1", channel: "WHATSAPP",
      template: {
        ...fullTemplate, wabaTemplateName: "review_ask", language: "en",
        bodyTemplate: "Hi {{name}}", providerStatus: "APPROVED",
        buttons: [{ type: "URL", text: "View", url: "https://x.co.za/loans/{{loanId}}" }],
      },
      vars: { name: "Thabo", loanId: "LN12345" },
      toValue: "27821234567",
    })

    const opts = vi.mocked(dispatch).mock.calls[0][3] as { waTemplate?: { components: unknown[] } }
    expect(opts.waTemplate?.components).toContainEqual({
      type: "button", sub_type: "url", index: "0",
      parameters: [{ type: "text", text: "LN12345" }],
    })
  })

  // The gate previously read placeholders from body + header only, so a button
  // variable could be missing and the template would still be sent — Meta would
  // then fall back to the approval-time example url for every borrower.
  it("does not build a template ref when a URL button's variable is missing", async () => {
    vi.mocked(prisma.commsSettings.findUnique).mockResolvedValue({ waProvider: "WA_CLOUD" } as never)
    const tx = buildTx()
    vi.mocked(prisma.$transaction).mockImplementation(async (cb: any) => cb(tx))
    vi.mocked(dispatch).mockResolvedValue({ providerMessageId: "wamid.T", acceptedAt: new Date() })
    vi.mocked(prisma.message.update).mockResolvedValue({} as any)

    await sendMessage({
      contactId: "ct1", channel: "WHATSAPP",
      template: {
        ...fullTemplate, wabaTemplateName: "review_ask", language: "en",
        bodyTemplate: "Hi {{name}}", providerStatus: "APPROVED",
        buttons: [{ type: "URL", text: "View", url: "https://x.co.za/loans/{{loanId}}" }],
      },
      vars: { name: "Thabo" }, // {{loanId}} missing — only referenced by the button url
      toValue: "27821234567",
    })

    expect(dispatch).toHaveBeenCalledWith("WHATSAPP", "WA_CLOUD", expect.anything(),
      expect.objectContaining({ contactId: "ct1", waTemplate: undefined }))
  })

  // "never ship a blank field" now means every placeholder, not just buttons.
  it("does not build a template ref when a header variable is blank", async () => {
    vi.mocked(prisma.commsSettings.findUnique).mockResolvedValue({ waProvider: "WA_CLOUD" } as never)
    const tx = buildTx()
    vi.mocked(prisma.$transaction).mockImplementation(async (cb: any) => cb(tx))
    vi.mocked(dispatch).mockResolvedValue({ providerMessageId: "wamid.T", acceptedAt: new Date() })
    vi.mocked(prisma.message.update).mockResolvedValue({} as any)

    await sendMessage({
      contactId: "ct1", channel: "WHATSAPP",
      template: {
        ...fullTemplate, wabaTemplateName: "review_ask", language: "en",
        bodyTemplate: "Hi {{name}}", headerContent: "Ref {{ref}}", providerStatus: "APPROVED",
      },
      vars: { name: "Thabo", ref: "   " }, // present but blank
      toValue: "27821234567",
    })

    expect(dispatch).toHaveBeenCalledWith("WHATSAPP", "WA_CLOUD", expect.anything(),
      expect.objectContaining({ contactId: "ct1", waTemplate: undefined }))
  })

  // A blank value is not a value. For a body word it renders an empty string;
  // appended to a url it produces a dead clickable link sent to a borrower.
  it("does not build a template ref when a URL button's variable is blank", async () => {
    vi.mocked(prisma.commsSettings.findUnique).mockResolvedValue({ waProvider: "WA_CLOUD" } as never)
    const tx = buildTx()
    vi.mocked(prisma.$transaction).mockImplementation(async (cb: any) => cb(tx))
    vi.mocked(dispatch).mockResolvedValue({ providerMessageId: "wamid.T", acceptedAt: new Date() })
    vi.mocked(prisma.message.update).mockResolvedValue({} as any)

    await sendMessage({
      contactId: "ct1", channel: "WHATSAPP",
      template: {
        ...fullTemplate, wabaTemplateName: "review_ask", language: "en",
        bodyTemplate: "Hi {{name}}", providerStatus: "APPROVED",
        buttons: [{ type: "URL", text: "View", url: "https://x.co.za/loans/{{loanId}}" }],
      },
      vars: { name: "Thabo", loanId: "   " },
      toValue: "27821234567",
    })

    expect(dispatch).toHaveBeenCalledWith("WHATSAPP", "WA_CLOUD", expect.anything(),
      expect.objectContaining({ contactId: "ct1", waTemplate: undefined }))
  })

  // Stored buttons that the CREATE path would refuse mean the approved template
  // and the stored row disagree — send nothing rather than a partial payload.
  it("does not build a template ref when stored buttons are structurally invalid", async () => {
    vi.mocked(prisma.commsSettings.findUnique).mockResolvedValue({ waProvider: "WA_CLOUD" } as never)
    const tx = buildTx()
    vi.mocked(prisma.$transaction).mockImplementation(async (cb: any) => cb(tx))
    vi.mocked(dispatch).mockResolvedValue({ providerMessageId: "wamid.T", acceptedAt: new Date() })
    vi.mocked(prisma.message.update).mockResolvedValue({} as any)

    await sendMessage({
      contactId: "ct1", channel: "WHATSAPP",
      template: {
        ...fullTemplate, wabaTemplateName: "review_ask", language: "en",
        bodyTemplate: "Hi {{name}}", providerStatus: "APPROVED",
        buttons: [{ type: "URL", text: "View", url: "https://x.co.za/{{a}}/stmt" }],
      },
      vars: { name: "Thabo", a: "LN1" },
      toValue: "27821234567",
    })

    expect(dispatch).toHaveBeenCalledWith("WHATSAPP", "WA_CLOUD", expect.anything(),
      expect.objectContaining({ contactId: "ct1", waTemplate: undefined }))
  })
})

describe("sendMessage — redactStoredBody templates", () => {
  const otpTemplate = {
    ...fullTemplate,
    body: "Your code is {{otp}}",
    bodyTemplate: "<p>Your code is {{otp}}</p>",
    redactStoredBody: true,
  } as any
  const plainTemplate = { ...otpTemplate, redactStoredBody: false } as any

  beforeEach(() => {
    vi.clearAllMocks()
    // Required by the fail-closed guard below; see the UNSUB_TOKEN_SECRET case.
    process.env.UNSUB_TOKEN_SECRET = "test-unsub-secret"
    process.env.NEXTAUTH_URL = "https://app.lender.example"
    vi.mocked(prisma.emailConfig.findUnique).mockResolvedValue({ active: true, provider: "IMAP_SMTP" } as any)
    vi.mocked(prisma.auditLog.create).mockResolvedValue({} as any)
  })

  afterEach(() => {
    delete process.env.UNSUB_TOKEN_SECRET
    delete process.env.NEXTAUTH_URL
  })

  async function send(template: any) {
    const tx = buildTx()
    vi.mocked(prisma.$transaction).mockImplementation(async (cb: any) => cb(tx))
    vi.mocked(dispatch).mockResolvedValue({ providerMessageId: "em-1", acceptedAt: providerAcceptedAt })
    await sendMessage({
      contactId: "ct1", channel: "EMAIL", template,
      vars: { otp: "483920" }, toValue: "x@y.com",
    })
    return tx.message.create.mock.calls[0]?.[0]?.data
  }

  it("persists the placeholder instead of the rendered body", async () => {
    const data = await send(otpTemplate)
    expect(data.bodyText).toBe(REDACTED_BODY_PLACEHOLDER)
    expect(data.bodyHtml).toBe(REDACTED_BODY_PLACEHOLDER)
  })

  it("stores no trace of the one-time code anywhere on the Message row", async () => {
    const data = await send(otpTemplate)
    expect(JSON.stringify(data)).not.toContain("483920")
  })

  it("still sends the TRUE body to the provider", async () => {
    await send(otpTemplate)
    expect(dispatch).toHaveBeenCalledWith("EMAIL", "SMTP", {
      subject: "Hello",
      text: "Your code is 483920",
      html: "<p>Your code is 483920</p>",
    }, expect.anything())
  })

  it("fingerprints the TRUE payload — identical to the non-redacted send", async () => {
    // Clock pinned: the fingerprint covers the unsubscribe token, which embeds the send time.
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(new Date("2026-01-15T10:00:00.000Z"))
    try {
      const redacted = await send(otpTemplate)
      const plain = await send(plainTemplate)
      expect(plain.bodyText).toBe("Your code is 483920")
      expect(redacted.payloadFingerprint).toBe(plain.payloadFingerprint)
    } finally {
      vi.useRealTimers()
    }
  })

  it("does not redact a template that has not opted in", async () => {
    const data = await send(plainTemplate)
    expect(data.bodyText).toBe("Your code is 483920")
    expect(data.bodyHtml).toBe("<p>Your code is 483920</p>")
  })

  it("tells the email provider to redact the EmailLog row too", async () => {
    // Message-level redaction alone is useless: providers.ts hands the true
    // body to sendEmail(), which writes bodyHtml/bodyText into EmailLog — a
    // table /api/email/logs exposes to ADMIN. The secret has to be suppressed
    // on BOTH sides or it is still sitting in plaintext.
    await send(otpTemplate)
    expect(dispatch).toHaveBeenCalledWith("EMAIL", "SMTP", expect.anything(),
      expect.objectContaining({ redactedBodyPlaceholder: REDACTED_BODY_PLACEHOLDER }))
  })

  it("leaves the EmailLog row alone for a non-redacted template", async () => {
    await send(plainTemplate)
    expect(dispatch).toHaveBeenCalledWith("EMAIL", "SMTP", expect.anything(),
      expect.objectContaining({ redactedBodyPlaceholder: undefined }))
  })

  it("refuses a redacted send when UNSUB_TOKEN_SECRET is missing", async () => {
    // Without the signed unsubscribe token in the canonical payload, every
    // term of the fingerprint is knowable and a 6-digit OTP falls in 10^6
    // hashes — so the redacted row leaks its own secret. UNSUB_TOKEN_SECRET is
    // unset in non-production environments, which is where walkthroughs happen.
    delete process.env.UNSUB_TOKEN_SECRET
    const tx = buildTx()
    vi.mocked(prisma.$transaction).mockImplementation(async (cb: any) => cb(tx))

    await expect(sendMessage({
      contactId: "ct1", channel: "EMAIL", template: otpTemplate,
      vars: { otp: "483920" }, toValue: "x@y.com",
    })).rejects.toThrow(/UNSUB_TOKEN_SECRET/)

    // Fail-closed BEFORE the reservation: no Message row, no provider call.
    expect(tx.message.create).not.toHaveBeenCalled()
    expect(dispatch).not.toHaveBeenCalled()
  })

  it("does not block a non-redacted send when UNSUB_TOKEN_SECRET is missing", async () => {
    delete process.env.UNSUB_TOKEN_SECRET
    const data = await send(plainTemplate)
    expect(data.bodyText).toBe("Your code is 483920")
  })

  it("passes referenceId and toName through so /api/email/logs stays queryable", async () => {
    const tx = buildTx()
    vi.mocked(prisma.$transaction).mockImplementation(async (cb: any) => cb(tx))
    vi.mocked(dispatch).mockResolvedValue({ providerMessageId: "em-1", acceptedAt: providerAcceptedAt })

    await sendMessage({
      contactId: "ct1", channel: "EMAIL", template: plainTemplate,
      vars: { otp: "1" }, toValue: "x@y.com",
      toName: "Sipho Nkosi", applicationId: "app-9",
    })

    expect(dispatch).toHaveBeenCalledWith("EMAIL", "SMTP", expect.anything(),
      expect.objectContaining({ referenceId: "app-9", toName: "Sipho Nkosi" }))
  })
})

describe("one open thread per contact", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(prisma.emailConfig.findUnique).mockResolvedValue({ active: true, provider: "IMAP_SMTP" } as any)
    vi.mocked(prisma.auditLog.create).mockResolvedValue({} as any)
  })

  it("resolveOrCreateConversationTx does not filter by channel", async () => {
    const tx = {
      conversation: {
        findFirst: vi.fn().mockResolvedValue({ id: "cv-existing" }),
        create: vi.fn(),
      },
    }

    const id = await resolveOrCreateConversationTx(tx as never, {
      contactId: "ct1",
      channel: "EMAIL",
      template: { id: "tpl1", tenantId: "t1" },
    } as never)

    expect(id).toBe("cv-existing")
    const where = tx.conversation.findFirst.mock.calls[0][0].where
    expect(where).toEqual({ tenantId: "t1", contactId: "ct1", closedAt: null })
    expect(Object.keys(where)).not.toContain("channel")
    expect(tx.conversation.create).not.toHaveBeenCalled()
  })

  it("reuses a WHATSAPP thread for an EMAIL send", async () => {
    const tx = {
      conversation: {
        findFirst: vi.fn().mockResolvedValue({ id: "cv-wa" }),
        create: vi.fn(),
      },
    }

    const id = await resolveOrCreateConversationTx(tx as never, {
      contactId: "ct1",
      channel: "EMAIL",
      template: { id: "tpl1", tenantId: "t1" },
    } as never)

    expect(id).toBe("cv-wa")
  })

  it("still honours an explicit opts.conversationId", async () => {
    const tx = { conversation: { findFirst: vi.fn(), create: vi.fn() } }

    const id = await resolveOrCreateConversationTx(tx as never, {
      conversationId: "cv-explicit",
      contactId: "ct1",
      channel: "EMAIL",
      template: { id: "tpl1", tenantId: "t1" },
    } as never)

    expect(id).toBe("cv-explicit")
    expect(tx.conversation.findFirst).not.toHaveBeenCalled()
  })

  it("creates a new thread carrying the send channel and linkages", async () => {
    const tx = {
      conversation: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({ id: "cv-new" }),
      },
    }

    const id = await resolveOrCreateConversationTx(tx as never, {
      contactId: "ct1",
      channel: "WHATSAPP",
      loanId: "ln1",
      applicationId: "ap1",
      template: { id: "tpl1", tenantId: "t1" },
    } as never)

    expect(id).toBe("cv-new")
    const data = tx.conversation.create.mock.calls[0][0].data
    expect(data.channel).toBe("WHATSAPP")
    expect(data.status).toBe("OPEN")
    expect(data.loanId).toBe("ln1")
    expect(data.applicationId).toBe("ap1")
    expect(data.lastActivityAt).toBeInstanceOf(Date)
  })

  // The nearest existing replay harness is "returns an existing terminal
  // business reservation without redispatching" above. Mirrored here with the
  // stubbed Conversation row carrying a channel that differs from
  // opts.channel — a real DB filtering `Conversation.channel = opts.channel`
  // would miss this row entirely and force a second thread. The direct proof
  // is the `where` clause passed to conversation.findFirst: it must not
  // constrain on channel at all.
  it("replays an idempotency key onto a thread whose conversation channel differs", async () => {
    vi.mocked(prisma.emailConfig.findUnique).mockResolvedValue({ active: true, provider: "IMAP_SMTP" } as any)
    const sentAt = new Date("2026-07-19T09:59:58.000Z")
    const existing = {
      id: "msg-existing",
      tenantId: "tn1",
      conversationId: "cv-existing",
      channel: "EMAIL",
      provider: "SMTP",
      templateId: "tpl1",
      status: "SENT",
      sentAt,
      dispatchState: "ACCEPTED",
      dispatchLeaseExpiresAt: null,
      direction: "OUTBOUND",
      subject: "Hello",
      bodyText: "Hi Sipho",
      bodyHtml: null,
      toValue: "x@y.com",
      payloadFingerprint: exactEmailFingerprint(),
    }
    const tx = buildTx({
      // The thread this idempotency key resolves to was opened on WHATSAPP —
      // it stayed open and later carried this EMAIL send too.
      conversation: { findFirst: vi.fn().mockResolvedValue({ id: "cv-existing", channel: "WHATSAPP" }) },
      message: { findUnique: vi.fn().mockResolvedValue(existing) },
    })
    vi.mocked(prisma.$transaction).mockImplementation(async (cb: any) => cb(tx))

    const result = await sendMessage({
      contactId: "ct1",
      channel: "EMAIL",
      template: fullTemplate,
      vars: { name: "Sipho" },
      toValue: "x@y.com",
      idempotencyKey: "notification:application_submitted:app1:EMAIL",
    })

    expect(result).toBe(existing)
    const where = tx.conversation.findFirst.mock.calls[0][0].where
    expect(Object.keys(where)).not.toContain("channel")
    expect(tx.message.create).not.toHaveBeenCalled()
    expect(dispatch).not.toHaveBeenCalled()
  })
})
