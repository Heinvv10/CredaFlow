/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, describe, it, expect, vi, beforeEach } from "vitest"
import { classifyError, backoff } from "./retry"
import { WA_OUTSIDE_WINDOW_NEEDS_TEMPLATE } from "@/lib/whatsapp/send-mode"

describe("backoff", () => {
  it("returns the documented schedule for retryCount 0..4", () => {
    expect(backoff(0)).toBe(60_000)        // 1m
    expect(backoff(1)).toBe(300_000)       // 5m
    expect(backoff(2)).toBe(1_800_000)     // 30m
    expect(backoff(3)).toBe(7_200_000)     // 2h
    expect(backoff(4)).toBe(43_200_000)    // 12h
  })

  it("returns null for retryCount >= 5 (signals exhaustion)", () => {
    expect(backoff(5)).toBeNull()
    expect(backoff(99)).toBeNull()
  })
})

describe("classifyError", () => {
  // Resend / Graph / SMTP — TRANSIENT
  it("classifies fetch timeout on RESEND as TRANSIENT", () => {
    const err = new Error("fetch failed: ETIMEDOUT")
    expect(classifyError(err, "RESEND")).toBe("TRANSIENT")
  })

  it("classifies 503 on MSGRAPH as TRANSIENT", () => {
    const err = new Error("MS Graph returned 503 Service Unavailable")
    expect(classifyError(err, "MSGRAPH")).toBe("TRANSIENT")
  })

  // Resend / Graph / SMTP — PERMANENT
  it("classifies 422 invalid recipient on RESEND as PERMANENT", () => {
    const err = new Error("Resend returned 422: invalid_to_address")
    expect(classifyError(err, "RESEND")).toBe("PERMANENT")
  })

  it("classifies 400 template_rejected on RESEND as PERMANENT", () => {
    const err = new Error("Resend returned 400: template_rejected")
    expect(classifyError(err, "RESEND")).toBe("PERMANENT")
  })

  it("classifies 429 quota_exceeded as PERMANENT (account out of budget)", () => {
    const err = new Error("Resend returned 429: quota_exceeded")
    expect(classifyError(err, "RESEND")).toBe("PERMANENT")
  })

  it("classifies 'Email not configured for this tenant' as PERMANENT (config gap, retry never helps)", () => {
    const err = new Error("Email not configured for this tenant. Go to Settings → Email.")
    expect(classifyError(err, "RESEND")).toBe("PERMANENT")
    expect(classifyError(err, "SMTP")).toBe("PERMANENT")
    expect(classifyError(err, "MSGRAPH")).toBe("PERMANENT")
  })

  it("classifies partial email-provider config as PERMANENT (MS Graph / SMTP incomplete)", () => {
    expect(classifyError(new Error("MS Graph config incomplete"), "MSGRAPH")).toBe("PERMANENT")
    expect(classifyError(new Error("SMTP config incomplete"), "SMTP")).toBe("PERMANENT")
  })

  it("does not let the email config-gap rule fire on a non-email provider", () => {
    // Provider isolation: the email rule must stay scoped to its case block.
    const err = new Error("Email not configured for this tenant. Go to Settings → Email.")
    expect(classifyError(err, "BULKSMS")).toBe("TRANSIENT")
  })

  // BulkSMS
  it("classifies BulkSMS 5xx as TRANSIENT", () => {
    const err = new Error("BulkSMS returned 502 Bad Gateway")
    expect(classifyError(err, "BULKSMS")).toBe("TRANSIENT")
  })

  it("classifies BulkSMS code 1001 as PERMANENT", () => {
    const err = new Error("BulkSMS error: {\"code\":1001,\"description\":\"invalid number\"}")
    expect(classifyError(err, "BULKSMS")).toBe("PERMANENT")
  })

  it("classifies 'BulkSMS not configured' as PERMANENT (config gap, retry never helps)", () => {
    const err = new Error("BulkSMS not configured")
    expect(classifyError(err, "BULKSMS")).toBe("PERMANENT")
  })

  // sendSms() refuses while BULKSMS_DRY_RUN is set. The env var will not
  // change between cron ticks, so retrying would accrue RETRYING rows for a
  // channel nobody is listening on — same shape as the WA "disabled" rule.
  it("classifies the SMS-channel-off refusal as PERMANENT, not endlessly retried", () => {
    const err = new Error("SMS not enabled")
    expect(classifyError(err, "BULKSMS")).toBe("PERMANENT")
  })

  it("does not let the BulkSMS config-gap rule fire on a non-SMS provider", () => {
    // Provider isolation: the BulkSMS rule must stay scoped to its case block.
    expect(classifyError(new Error("BulkSMS not configured"), "RESEND")).toBe("TRANSIENT")
  })

  // WA unofficial
  it("classifies WA connection-refused as TRANSIENT", () => {
    const err = new Error("connect ECONNREFUSED 192.0.2.10:8083")
    expect(classifyError(err, "WA_UNOFFICIAL")).toBe("TRANSIENT")
  })

  it("classifies WA 401 auth error as PERMANENT", () => {
    const err = new Error("WA sender returned 401: invalid token")
    expect(classifyError(err, "WA_UNOFFICIAL")).toBe("PERMANENT")
  })

  it("classifies 'WhatsApp disabled' as PERMANENT (env-config, retry never helps)", () => {
    const err = new Error("WhatsApp disabled")
    expect(classifyError(err, "WA_UNOFFICIAL")).toBe("PERMANENT")
  })

  // WA Cloud — outside-window rejection (see lib/whatsapp/send-mode.ts). Meta
  // rejects free-form text outside the 24h service window; retrying the exact
  // same send can never succeed, so this must classify PERMANENT rather than
  // fall through to the provider-default TRANSIENT (which would leave the
  // message RETRYING and burn 5 doomed cron attempts before it ever reaches
  // lib/inbox/dispatch.ts's OUTSIDE_WINDOW mapping).
  it("classifies WA_OUTSIDE_WINDOW_NEEDS_TEMPLATE on WA_CLOUD as PERMANENT", () => {
    const err = new ProviderDispatchError(WA_OUTSIDE_WINDOW_NEEDS_TEMPLATE, "DEFINITELY_REJECTED")
    expect(classifyError(err, "WA_CLOUD")).toBe("PERMANENT")
  })

  it("does not over-match: an unrelated WA_CLOUD transient error still classifies as TRANSIENT", () => {
    const err = new Error("connect ECONNREFUSED 192.0.2.10:8083")
    expect(classifyError(err, "WA_CLOUD")).toBe("TRANSIENT")
  })

  // Unknown shape — TRANSIENT default (over-retry, don't drop)
  it("defaults to TRANSIENT for unrecognised error shapes", () => {
    const err = new Error("something weird happened")
    expect(classifyError(err, "RESEND")).toBe("TRANSIENT")
  })

  it("defaults to TRANSIENT for unrecognised providers", () => {
    const err = new Error("any error")
    expect(classifyError(err, "CHATBOT")).toBe("TRANSIENT")
  })
})

// ── processRetryBatch tests ──────────────────────────────────────────────────

// Shared mocks for the long-lived advisory sweep transaction (`txMock`) and
// independently committed per-message eligibility/claim/finalisation work
// (`globalTxMock`). This separation is load-bearing: consent row locks must not
// survive across provider calls or unrelated rows.
// Tests that exercise the lock-busy path override $queryRaw per-call.
// hoisted() so we can reference the mock object inside the vi.mock factory
// (vi.mock is hoisted to top-of-file by Vitest).
const { txMock, globalTxMock, globalMessageMock } = vi.hoisted(() => {
  const globalMessageMock = {
    updateMany: vi.fn(),
    findFirst: vi.fn(),
    findFirstOrThrow: vi.fn(),
  }
  return {
    globalMessageMock,
    globalTxMock: {
      message: globalMessageMock,
      conversation: { updateMany: vi.fn() },
      notificationLog: { updateMany: vi.fn() },
      auditLog: { create: vi.fn() },
    },
    txMock: {
      message: {
        findMany: vi.fn(),
        updateMany: vi.fn(),
        update: vi.fn(),
      },
      messageTemplate: { findUniqueOrThrow: vi.fn() },
      conversation: { findUniqueOrThrow: vi.fn() },
      contact: { findUniqueOrThrow: vi.fn() },
      notificationLog: { updateMany: vi.fn() },
      auditLog: { create: vi.fn() },
      $queryRaw: vi.fn().mockResolvedValue([{ acquired: true }]),
      $queryRawUnsafe: vi.fn().mockResolvedValue([]),
    },
  }
})

vi.mock("@/lib/prisma", () => ({
  prisma: {
    // The retry no-replay claim intentionally uses the global client so it
    // survives an outer sweep rollback. Keep this distinct from txMock or a
    // unit test would erase the very transaction boundary under test.
    message: globalMessageMock,
    messageTemplate: txMock.messageTemplate,
    conversation: txMock.conversation,
    // The sweep wraps its body in $transaction; the callback receives `tx`
    // which we route to txMock so the existing tests keep using prisma.* mocks.
    $transaction: vi.fn().mockImplementation(async (cb: any, options?: any) => (
      cb(options?.timeout ? txMock : globalTxMock)
    )),
  },
}))

vi.mock("./send", () => ({
  canSendTx: vi.fn(),
  resolveProvider: vi.fn(),
}))

vi.mock("./providers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./providers")>()),
  dispatch: vi.fn(),
}))

vi.mock("@/lib/audit", () => ({ logAudit: vi.fn() }))

import { processRetryBatch } from "./retry"
import { prisma } from "@/lib/prisma"
import { canSendTx, resolveProvider } from "./send"
import { dispatch, ProviderDispatchError } from "./providers"
import { logAudit } from "@/lib/audit"

const baseMessage = {
  id: "msg1", tenantId: "tn1", conversationId: "cv1",
  channel: "SMS", direction: "OUTBOUND", provider: "BULKSMS",
  status: "RETRYING", retryCount: 1, nextRetryAt: new Date(Date.now() - 1000),
  lastErrorAt: new Date(), errorClass: "TRANSIENT",
  templateId: "tpl1", toValue: "27820000000",
  bodyText: "Hi", bodyHtml: null, subject: "S",
  lawfulBasis: "SERVICE_COMMS_NCA",
  createdAt: new Date(),
} as any

describe("processRetryBatch", () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  beforeEach(() => {
    vi.clearAllMocks()
    // Restore $transaction routing + lock-acquired default after clearAllMocks.
    vi.mocked(prisma.$transaction).mockImplementation(async (cb: any, options?: any) => (
      cb(options?.timeout ? txMock : globalTxMock)
    ))
    txMock.$queryRaw.mockResolvedValue([{ acquired: true }])
    txMock.messageTemplate.findUniqueOrThrow.mockReset().mockResolvedValue({
      id: "tpl1",
      tenantId: "tn1",
    } as any)
    txMock.conversation.findUniqueOrThrow.mockReset().mockResolvedValue({
      contactId: "ct1",
      tenantId: "tn1",
    } as any)
    txMock.contact.findUniqueOrThrow.mockReset().mockResolvedValue({
      id: "ct1",
      tenantId: "tn1",
    } as any)
    txMock.auditLog.create.mockReset().mockResolvedValue({} as any)
    txMock.notificationLog.updateMany.mockResolvedValue({ count: 0 } as any)
    globalMessageMock.updateMany.mockResolvedValue({ count: 1 } as any)
    globalMessageMock.findFirst.mockResolvedValue(null)
    globalMessageMock.findFirstOrThrow.mockResolvedValue({ ...baseMessage, status: "SENT" } as any)
    globalTxMock.conversation.updateMany.mockResolvedValue({ count: 1 } as any)
    globalTxMock.notificationLog.updateMany.mockResolvedValue({ count: 0 } as any)
    globalTxMock.auditLog.create.mockResolvedValue({} as any)
  })

  it("bulk-expires messages older than 24h before processing", async () => {
    txMock.message.updateMany.mockResolvedValue({ count: 3 } as any)
    txMock.message.findMany.mockResolvedValue([])

    const r = await processRetryBatch({ limit: 50, now: new Date() })

    expect(txMock.message.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: "RETRYING",
          createdAt: { lt: expect.any(Date) },
        }),
        data: { status: "EXPIRED", errorClass: "EXPIRED" },
      })
    )
    expect(txMock.notificationLog.updateMany).toHaveBeenCalledWith({
      where: {
        messageId: { not: null },
        message: { status: "EXPIRED" },
      },
      data: {
        status: "expired",
        error: "Message retry window expired after 24 hours",
      },
    })
    expect(r.expired).toBe(3)
  })

  it("picks rows where status=RETRYING AND nextRetryAt <= now() ordered by nextRetryAt", async () => {
    txMock.message.updateMany.mockResolvedValue({ count: 0 } as any)
    txMock.message.findMany.mockResolvedValue([])

    await processRetryBatch({ limit: 50, now: new Date("2026-05-22T10:00:00Z") })

    expect(txMock.message.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: "RETRYING",
          nextRetryAt: { lte: expect.any(Date) },
        }),
        orderBy: { nextRetryAt: "asc" },
        take: 50,
      })
    )
  })

  it("suppresses a legacy EMAIL retry before any payload reconstruction or provider call", async () => {
    const now = new Date("2026-07-22T20:30:00.000Z")
    const emailMessage = {
      ...baseMessage,
      channel: "EMAIL",
      provider: "SMTP",
      toValue: "synthetic@example.test",
      payloadFingerprint: "a".repeat(64),
    }
    txMock.message.updateMany
      .mockResolvedValueOnce({ count: 0 } as any)
      .mockResolvedValueOnce({ count: 1 } as any)
    txMock.message.findMany.mockResolvedValue([emailMessage])

    const result = await processRetryBatch({ limit: 50, now })

    expect(result).toMatchObject({ scanned: 1, failedPermanent: 1, dispatched: 0 })
    expect(txMock.message.updateMany).toHaveBeenLastCalledWith({
      where: {
        id: "msg1",
        tenantId: "tn1",
        status: "RETRYING",
        retryCount: 1,
      },
      data: expect.objectContaining({
        status: "FAILED_PERMANENT",
        nextRetryAt: null,
        errorClass: "EMAIL_PAYLOAD_NOT_RECONSTRUCTABLE",
        lastErrorAt: now,
      }),
    })
    expect(txMock.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "MESSAGE_RETRY_SUPPRESSED_NON_RECONSTRUCTABLE_PAYLOAD",
        newValue: expect.objectContaining({
          payloadFingerprint: "a".repeat(64),
          automaticReplayDisabled: true,
          providerDispatchStarted: false,
        }),
      }),
    })
    expect(txMock.notificationLog.updateMany).toHaveBeenCalledWith({
      where: { tenantId: "tn1", messageId: "msg1" },
      data: {
        status: "failed",
        error: expect.stringMatching(/attachments and headers are not durably reconstructable/i),
      },
    })
    expect(txMock.messageTemplate.findUniqueOrThrow).not.toHaveBeenCalled()
    expect(resolveProvider).not.toHaveBeenCalled()
    expect(dispatch).not.toHaveBeenCalled()
  })

  it("transitions to SUPPRESSED_BY_CONSENT when canSendTx now returns ok:false", async () => {
    txMock.message.updateMany
      .mockResolvedValueOnce({ count: 0 } as any)
    txMock.message.findMany.mockResolvedValue([baseMessage])
    vi.mocked(prisma.messageTemplate.findUniqueOrThrow).mockResolvedValue({ id: "tpl1", tenantId: "tn1" } as any)
    vi.mocked(prisma.conversation.findUniqueOrThrow).mockResolvedValue({ contactId: "ct1" } as any)
    vi.mocked(canSendTx).mockResolvedValue({ ok: false, reason: "CHANNEL_OPTED_OUT" } as any)
    txMock.message.update.mockResolvedValue({} as any)

    const r = await processRetryBatch({ limit: 50, now: new Date() })

    expect(r.suppressed).toBe(1)
    expect(r.dispatched).toBe(0)
    expect(globalTxMock.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "MESSAGE_SUPPRESSED_BY_CONSENT",
        entityId: "msg1",
      }),
    })
    expect(globalTxMock.notificationLog.updateMany).toHaveBeenCalledWith({
      where: { tenantId: "tn1", messageId: "msg1" },
      data: {
        status: "suppressed_by_consent",
        error: "canSendTx rejected on retry: CHANNEL_OPTED_OUT",
      },
    })
    expect(canSendTx).toHaveBeenCalledWith(globalTxMock, "ct1", "SMS", expect.any(Object))
    expect(canSendTx).not.toHaveBeenCalledWith(txMock, expect.anything(), expect.anything(), expect.anything())
  })

  it.each([
    ["template", { templateTenantId: "tn-other" }],
    ["conversation", { conversationTenantId: "tn-other" }],
    ["contact", { contactTenantId: "tn-other" }],
  ] as const)("fails closed before provider dispatch when the %s belongs to another tenant", async (relation, mismatch) => {
    txMock.message.updateMany
      .mockResolvedValueOnce({ count: 0 } as any)
      .mockResolvedValueOnce({ count: 1 } as any)
    txMock.message.findMany.mockResolvedValue([baseMessage])
    txMock.messageTemplate.findUniqueOrThrow.mockResolvedValue({
      id: "tpl1",
      tenantId: "templateTenantId" in mismatch ? mismatch.templateTenantId : "tn1",
    } as any)
    txMock.conversation.findUniqueOrThrow.mockResolvedValue({
      contactId: "ct1",
      tenantId: "conversationTenantId" in mismatch ? mismatch.conversationTenantId : "tn1",
    } as any)
    txMock.contact.findUniqueOrThrow.mockResolvedValue({
      id: "ct1",
      tenantId: "contactTenantId" in mismatch ? mismatch.contactTenantId : "tn1",
    } as any)

    const result = await processRetryBatch({ limit: 50, now: new Date() })

    expect(result).toMatchObject({
      scanned: 1,
      failedPermanent: 1,
      dispatched: 0,
      simulated: 0,
    })
    expect(txMock.message.updateMany).toHaveBeenLastCalledWith({
      where: {
        id: "msg1",
        tenantId: "tn1",
        status: "RETRYING",
        retryCount: 1,
      },
      data: expect.objectContaining({
        status: "FAILED_PERMANENT",
        nextRetryAt: null,
        errorClass: "TENANT_INTEGRITY",
        errorMessage: expect.stringContaining(relation),
      }),
    })
    expect(txMock.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId: "tn1",
        action: "MESSAGE_RETRY_SUPPRESSED_TENANT_INTEGRITY",
        entityId: "msg1",
        newValue: expect.objectContaining({
          invalidRelation: relation,
          automaticReplayDisabled: true,
          providerDispatchStarted: false,
        }),
      }),
    })
    expect(txMock.notificationLog.updateMany).toHaveBeenCalledWith({
      where: { tenantId: "tn1", messageId: "msg1" },
      data: {
        status: "failed",
        error: expect.stringContaining(relation),
      },
    })
    expect(globalMessageMock.updateMany).not.toHaveBeenCalled()
    expect(canSendTx).not.toHaveBeenCalled()
    expect(dispatch).not.toHaveBeenCalled()
  })

  it("re-dispatches and transitions to SENT on successful retry", async () => {
    txMock.message.updateMany.mockResolvedValue({ count: 0 } as any)
    txMock.message.findMany.mockResolvedValue([baseMessage])
    vi.mocked(prisma.messageTemplate.findUniqueOrThrow).mockResolvedValue({ id: "tpl1", tenantId: "tn1" } as any)
    vi.mocked(prisma.conversation.findUniqueOrThrow).mockResolvedValue({ contactId: "ct1" } as any)
    vi.mocked(canSendTx).mockResolvedValue({ ok: true, basis: "SERVICE_COMMS_NCA", evidence: "x" } as any)
    vi.mocked(resolveProvider).mockResolvedValue("BULKSMS" as any)
    const acceptedAt = new Date("2026-07-19T10:00:00.000Z")
    vi.mocked(dispatch).mockResolvedValue({ providerMessageId: "prov-retry-1", acceptedAt })
    txMock.message.updateMany.mockResolvedValue({ count: 1 } as any)

    const r = await processRetryBatch({ limit: 50, now: new Date() })

    expect(r.dispatched).toBe(1)
    expect(globalMessageMock.updateMany.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
      where: expect.objectContaining({ id: "msg1", tenantId: "tn1", status: "RETRYING" }),
      data: expect.objectContaining({
        status: "QUEUED",
        nextRetryAt: null,
        errorClass: null,
        dispatchState: "DISPATCHING",
        dispatchToken: expect.any(String),
        dispatchLeaseExpiresAt: expect.any(Date),
      }),
    }))
    expect(globalMessageMock.updateMany.mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(dispatch).mock.invocationCallOrder[0])
    expect(canSendTx).toHaveBeenCalledWith(globalTxMock, "ct1", "SMS", expect.any(Object))
    expect(canSendTx).not.toHaveBeenCalledWith(txMock, expect.anything(), expect.anything(), expect.anything())
    expect(vi.mocked(prisma.$transaction)).toHaveBeenCalledWith(
      expect.any(Function),
      { isolationLevel: "Serializable" },
    )
    expect(globalMessageMock.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "msg1" }),
        data: expect.objectContaining({
          status: "SENT",
          sentAt: acceptedAt,
          providerMessageId: "prov-retry-1",
          dispatchState: "ACCEPTED",
          dispatchProviderMessageId: "prov-retry-1",
        }),
      })
    )
    expect(globalTxMock.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ action: "MESSAGE_SENT", entityId: "msg1" }),
    }))
    expect(globalTxMock.conversation.updateMany).toHaveBeenCalledWith({
      where: {
        id: "cv1",
        tenantId: "tn1",
        OR: [{ lastOutboundAt: null }, { lastOutboundAt: { lt: acceptedAt } }],
      },
      data: { lastOutboundAt: acceptedAt },
    })
  })

  it("uses a separate short eligibility-and-claim transaction for every batch row", async () => {
    const secondMessage = {
      ...baseMessage,
      id: "msg2",
      conversationId: "cv2",
      toValue: "27820000001",
    }
    txMock.message.updateMany.mockResolvedValue({ count: 0 } as any)
    txMock.message.findMany.mockResolvedValue([baseMessage, secondMessage])
    txMock.conversation.findUniqueOrThrow
      .mockResolvedValueOnce({ contactId: "ct1", tenantId: "tn1" } as any)
      .mockResolvedValueOnce({ contactId: "ct2", tenantId: "tn1" } as any)
    txMock.contact.findUniqueOrThrow
      .mockResolvedValueOnce({ id: "ct1", tenantId: "tn1" } as any)
      .mockResolvedValueOnce({ id: "ct2", tenantId: "tn1" } as any)
    vi.mocked(canSendTx).mockResolvedValue({
      ok: true,
      basis: "SERVICE_COMMS_NCA",
      evidence: "x",
    } as any)
    vi.mocked(resolveProvider).mockResolvedValue("BULKSMS" as any)
    vi.mocked(dispatch)
      .mockResolvedValueOnce({ providerMessageId: "provider-msg-1", acceptedAt: new Date() })
      .mockResolvedValueOnce({ providerMessageId: "provider-msg-2", acceptedAt: new Date() })
    globalMessageMock.findFirstOrThrow.mockImplementation(async (args: any) => ({
      ...baseMessage,
      id: args.where.id,
      status: "SENT",
    }))

    const result = await processRetryBatch({ limit: 50, now: new Date() })

    expect(result).toMatchObject({ scanned: 2, dispatched: 2 })
    expect(canSendTx).toHaveBeenNthCalledWith(1, globalTxMock, "ct1", "SMS", expect.any(Object))
    expect(canSendTx).toHaveBeenNthCalledWith(2, globalTxMock, "ct2", "SMS", expect.any(Object))
    const eligibilityTransactions = vi.mocked(prisma.$transaction).mock.calls.filter(
      ([, options]: any[]) => options?.isolationLevel === "Serializable",
    )
    expect(eligibilityTransactions).toHaveLength(2)
    expect(globalTxMock.auditLog.create.mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(dispatch).mock.invocationCallOrder[0])
  })

  it("transitions a dry-run retry to SIMULATED without claiming it was sent", async () => {
    txMock.message.updateMany.mockResolvedValue({ count: 0 } as any)
    txMock.message.findMany.mockResolvedValue([baseMessage])
    vi.mocked(prisma.messageTemplate.findUniqueOrThrow).mockResolvedValue({ id: "tpl1", tenantId: "tn1" } as any)
    vi.mocked(prisma.conversation.findUniqueOrThrow).mockResolvedValue({ contactId: "ct1" } as any)
    vi.mocked(canSendTx).mockResolvedValue({ ok: true, basis: "SERVICE_COMMS_NCA", evidence: "x" } as any)
    vi.mocked(resolveProvider).mockResolvedValue("BULKSMS" as any)
    vi.mocked(dispatch).mockResolvedValue({
      simulationReceiptId: "dry-run-retry-1",
      simulated: true,
    })
    txMock.message.update.mockResolvedValue({} as any)

    const result = await processRetryBatch({ limit: 50, now: new Date() })

    expect(result.dispatched).toBe(0)
    expect(result.simulated).toBe(1)
    expect(globalMessageMock.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: "msg1" }),
      data: expect.objectContaining({
        status: "SIMULATED",
        sentAt: null,
        providerMessageId: null,
        dispatchState: "SIMULATED",
        dispatchProviderMessageId: null,
        simulationReceiptId: "dry-run-retry-1",
        dispatchProviderAcceptedAt: null,
      }),
    }))
    expect(globalTxMock.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        action: "MESSAGE_SIMULATED",
        newValue: expect.objectContaining({ simulated: true, providerAcceptedAt: null, viaRetryCron: true }),
      }),
    }))
  })

  it("never reschedules a provider-accepted retry when the first terminal write fails", async () => {
    txMock.message.updateMany.mockResolvedValue({ count: 0 } as any)
    txMock.message.findMany.mockResolvedValue([baseMessage])
    txMock.messageTemplate.findUniqueOrThrow.mockResolvedValue({ id: "tpl1", tenantId: "tn1" } as any)
    txMock.conversation.findUniqueOrThrow.mockResolvedValue({ contactId: "ct1" } as any)
    vi.mocked(canSendTx).mockResolvedValue({ ok: true, basis: "SERVICE_COMMS_NCA", evidence: "x" } as any)
    vi.mocked(resolveProvider).mockResolvedValue("BULKSMS" as any)
    const acceptedAt = new Date("2026-07-19T10:00:00.000Z")
    vi.mocked(dispatch).mockResolvedValue({
      providerMessageId: "provider-accepted-1",
      acceptedAt,
    })
    globalMessageMock.updateMany
      .mockResolvedValueOnce({ count: 1 } as any) // durable no-replay claim
      .mockRejectedValueOnce(new Error("terminal write timed out"))
      .mockResolvedValueOnce({ count: 1 } as any) // exact terminal recovery

    const result = await processRetryBatch({ limit: 50, now: new Date() })

    expect(result.dispatched).toBe(1)
    expect(result.rescheduled).toBe(0)
    expect(result.manualReconciliation).toBe(0)
    expect(globalMessageMock.updateMany).not.toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "RETRYING" }),
    }))
    expect(globalTxMock.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        action: "MESSAGE_SENT",
        newValue: expect.objectContaining({
          providerMessageId: "provider-accepted-1",
          postDispatchRecovery: true,
        }),
      }),
    }))
    expect(globalTxMock.conversation.updateMany).toHaveBeenCalledWith({
      where: {
        id: "cv1",
        tenantId: "tn1",
        OR: [{ lastOutboundAt: null }, { lastOutboundAt: { lt: acceptedAt } }],
      },
      data: { lastOutboundAt: acceptedAt },
    })
    expect(logAudit).not.toHaveBeenCalledWith(expect.objectContaining({
      action: "MESSAGE_RETRY_ATTEMPTED",
    }))
  })

  it("leaves a simulated retry on its durable no-replay claim when both terminal writes fail", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    txMock.message.updateMany.mockResolvedValue({ count: 0 } as any)
    txMock.message.findMany.mockResolvedValue([baseMessage])
    txMock.messageTemplate.findUniqueOrThrow.mockResolvedValue({ id: "tpl1", tenantId: "tn1" } as any)
    txMock.conversation.findUniqueOrThrow.mockResolvedValue({ contactId: "ct1" } as any)
    vi.mocked(canSendTx).mockResolvedValue({ ok: true, basis: "SERVICE_COMMS_NCA", evidence: "x" } as any)
    vi.mocked(resolveProvider).mockResolvedValue("BULKSMS" as any)
    vi.mocked(dispatch).mockResolvedValue({
      simulationReceiptId: "dry-run-retry-unrecorded",
      simulated: true,
    })
    globalMessageMock.updateMany
      .mockResolvedValueOnce({ count: 1 } as any) // durable no-replay claim
      .mockRejectedValueOnce(new Error("terminal write failed"))
      .mockRejectedValueOnce(new Error("terminal recovery failed"))
      .mockResolvedValueOnce({ count: 1 } as any) // durable reconciliation hold
    globalMessageMock.findFirstOrThrow.mockResolvedValue({
      ...baseMessage,
      status: "QUEUED",
      dispatchState: "SIMULATED",
      dispatchProviderMessageId: null,
      simulationReceiptId: "dry-run-retry-unrecorded",
    } as any)

    const result = await processRetryBatch({ limit: 50, now: new Date() })

    expect(result.simulated).toBe(0)
    expect(result.rescheduled).toBe(0)
    expect(result.manualReconciliation).toBe(1)
    expect(globalMessageMock.updateMany).not.toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "RETRYING" }),
    }))
    expect(globalTxMock.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        action: "MESSAGE_SIMULATED_DB_WRITE_FAILED",
        newValue: expect.objectContaining({
          providerMessageId: null,
          simulationReceiptId: "dry-run-retry-unrecorded",
          providerAcceptedAt: null,
          automaticReplayDisabled: true,
        }),
      }),
    }))
    expect(logAudit).not.toHaveBeenCalledWith(expect.objectContaining({
      action: "MESSAGE_RETRY_ATTEMPTED",
    }))
    errorSpy.mockRestore()
  })

  it("never replays an ambiguous provider outcome on a later sweep", async () => {
    txMock.message.updateMany.mockResolvedValue({ count: 0 } as any)
    txMock.message.findMany
      .mockResolvedValueOnce([baseMessage])
      .mockResolvedValueOnce([])
    txMock.messageTemplate.findUniqueOrThrow.mockResolvedValue({ id: "tpl1", tenantId: "tn1" } as any)
    txMock.conversation.findUniqueOrThrow.mockResolvedValue({ contactId: "ct1" } as any)
    vi.mocked(canSendTx).mockResolvedValue({ ok: true, basis: "SERVICE_COMMS_NCA", evidence: "x" } as any)
    vi.mocked(resolveProvider).mockResolvedValue("BULKSMS" as any)
    vi.mocked(dispatch).mockRejectedValue(
      new ProviderDispatchError("provider response timed out", "AMBIGUOUS"),
    )

    const first = await processRetryBatch({ limit: 50, now: new Date() })
    const second = await processRetryBatch({ limit: 50, now: new Date(Date.now() + 60_000) })

    expect(first.manualReconciliation).toBe(1)
    expect(first.rescheduled).toBe(0)
    expect(second.scanned).toBe(0)
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(globalMessageMock.updateMany).not.toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "RETRYING" }),
    }))
    expect(globalTxMock.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        action: "MESSAGE_RETRY_DISPATCH_RECONCILIATION_REQUIRED",
        newValue: expect.objectContaining({
          providerOutcome: "AMBIGUOUS",
          automaticReplayDisabled: true,
        }),
      }),
    }))
  })

  it("uses immutable send-time basis to suppress retry even after the template flag changes", async () => {
    txMock.message.updateMany
      .mockResolvedValueOnce({ count: 0 } as any)
      .mockResolvedValueOnce({ count: 1 } as any)
    txMock.message.findMany.mockResolvedValue([{
      ...baseMessage,
      lawfulBasis: "STATUTORY_OVERRIDE",
    }])
    vi.mocked(prisma.messageTemplate.findUniqueOrThrow).mockResolvedValue({
      id: "tpl1",
      tenantId: "tn1",
      key: "renamed_after_send",
      statutoryOverride: false,
    } as any)
    txMock.message.update.mockResolvedValue({} as any)

    const now = new Date("2026-07-20T10:00:00.000Z")
    const r = await processRetryBatch({ limit: 50, now })

    expect(r.failedPermanent).toBe(1)
    expect(r.dispatched).toBe(0)
    expect(txMock.message.updateMany).toHaveBeenCalledWith({
      where: {
        id: "msg1",
        tenantId: "tn1",
        status: "RETRYING",
        retryCount: 1,
      },
      data: {
        status: "FAILED_PERMANENT",
        nextRetryAt: null,
        errorClass: "STATUTORY_MANUAL_RECONCILIATION",
        errorMessage: expect.stringMatching(/reconcile through the owning workflow/i),
        lastErrorAt: now,
      },
    })
    expect(txMock.notificationLog.updateMany).toHaveBeenCalledWith({
      where: { tenantId: "tn1", messageId: "msg1" },
      data: {
        status: "failed",
        error: expect.stringMatching(/reconcile through the owning workflow/i),
      },
    })
    expect(prisma.conversation.findUniqueOrThrow).not.toHaveBeenCalled()
    expect(canSendTx).not.toHaveBeenCalled()
    expect(resolveProvider).not.toHaveBeenCalled()
    expect(dispatch).not.toHaveBeenCalled()
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: "MESSAGE_RETRY_SUPPRESSED_NON_REPLAYABLE",
      entityId: "msg1",
      newValue: expect.objectContaining({
        templateKey: "renamed_after_send",
        manualReconciliationRequired: true,
      }),
    }))
  })

  it("refuses to replay a redactStoredBody template — it would deliver the placeholder", async () => {
    // The rebuild below reads the PERSISTED body, which for a redacted
    // template is "[redacted — ...]". Replaying it would send that literal
    // string to the consumer instead of their one-time code or signing link,
    // and the vars needed to re-render are not persisted. Explicit guard, not
    // reliance on every redacted callsite passing
    // automaticRetry:false.
    txMock.message.updateMany
      .mockResolvedValueOnce({ count: 0 } as any)
      .mockResolvedValueOnce({ count: 1 } as any)
    txMock.message.findMany.mockResolvedValue([{ ...baseMessage }])
    vi.mocked(prisma.messageTemplate.findUniqueOrThrow).mockResolvedValue({
      id: "tpl1",
      tenantId: "tn1",
      key: "portal_activation_email",
      statutoryOverride: false,
      redactStoredBody: true,
    } as any)
    txMock.message.update.mockResolvedValue({} as any)

    const now = new Date("2026-07-20T10:00:00.000Z")
    const r = await processRetryBatch({ limit: 50, now })

    expect(r.failedPermanent).toBe(1)
    expect(r.dispatched).toBe(0)
    expect(dispatch).not.toHaveBeenCalled()
    expect(txMock.message.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: "FAILED_PERMANENT",
        errorClass: "REDACTED_BODY_NOT_REPLAYABLE",
        errorMessage: expect.stringMatching(/redacted/i),
      }),
    }))
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: "MESSAGE_RETRY_SUPPRESSED_NON_REPLAYABLE",
      newValue: expect.objectContaining({
        errorClass: "REDACTED_BODY_NOT_REPLAYABLE",
        templateKey: "portal_activation_email",
      }),
    }))
  })

  it("transitions to FAILED_PERMANENT on the 6th attempt with TRANSIENT failure (retryCount=5 → backoff returns null)", async () => {
    const exhausted = { ...baseMessage, retryCount: 5 } // 6th attempt — backoff(5)=null
    txMock.message.updateMany.mockResolvedValue({ count: 0 } as any)
    txMock.message.findMany.mockResolvedValue([exhausted])
    vi.mocked(prisma.messageTemplate.findUniqueOrThrow).mockResolvedValue({ id: "tpl1", tenantId: "tn1" } as any)
    vi.mocked(prisma.conversation.findUniqueOrThrow).mockResolvedValue({ contactId: "ct1" } as any)
    vi.mocked(canSendTx).mockResolvedValue({ ok: true, basis: "SERVICE_COMMS_NCA", evidence: "x" } as any)
    vi.mocked(resolveProvider).mockResolvedValue("BULKSMS" as any)
    vi.mocked(dispatch).mockRejectedValue(
      new ProviderDispatchError("network timeout", "DEFINITELY_REJECTED"),
    )
    txMock.message.update.mockResolvedValue({} as any)

    const r = await processRetryBatch({ limit: 50, now: new Date() })

    expect(r.failedPermanent).toBe(1)
    expect(r.dispatched).toBe(0)
    expect(globalMessageMock.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "msg1" }),
        data: expect.objectContaining({
          status: "FAILED_PERMANENT",
          errorClass: "TRANSIENT",
        }),
      })
    )
  })

  it("reschedules with 12h backoff on TRANSIENT at retryCount=4 (5th attempt)", async () => {
    const fifth = { ...baseMessage, retryCount: 4 }
    txMock.message.updateMany.mockResolvedValue({ count: 0 } as any)
    txMock.message.findMany.mockResolvedValue([fifth])
    vi.mocked(prisma.messageTemplate.findUniqueOrThrow).mockResolvedValue({ id: "tpl1", tenantId: "tn1" } as any)
    vi.mocked(prisma.conversation.findUniqueOrThrow).mockResolvedValue({ contactId: "ct1" } as any)
    vi.mocked(canSendTx).mockResolvedValue({ ok: true, basis: "SERVICE_COMMS_NCA", evidence: "x" } as any)
    vi.mocked(resolveProvider).mockResolvedValue("BULKSMS" as any)
    vi.mocked(dispatch).mockRejectedValue(
      new ProviderDispatchError("502 Bad Gateway", "DEFINITELY_REJECTED"),
    )
    txMock.message.update.mockResolvedValue({} as any)

    const sweepNow = new Date("2026-05-22T10:00:00Z")
    const failureClock = new Date("2026-05-22T11:17:00Z")
    vi.useFakeTimers()
    vi.setSystemTime(failureClock)

    const r = await processRetryBatch({ limit: 50, now: sweepNow })

    expect(r.rescheduled).toBe(1)
    expect(r.failedPermanent).toBe(0)
    expect(globalMessageMock.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "msg1" }),
        data: expect.objectContaining({
          status: "RETRYING",
          retryCount: 5,
          // A slow batch must not burn 77 minutes of this row's 12h backoff.
          nextRetryAt: new Date(failureClock.getTime() + 43_200_000),
        }),
      })
    )
    expect(globalTxMock.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ action: "MESSAGE_RETRY_SCHEDULED", entityId: "msg1" }),
    }))
    vi.useRealTimers()
  })

  it("transitions to FAILED_PERMANENT immediately on PERMANENT classifier result", async () => {
    txMock.message.updateMany.mockResolvedValue({ count: 0 } as any)
    txMock.message.findMany.mockResolvedValue([baseMessage])
    vi.mocked(prisma.messageTemplate.findUniqueOrThrow).mockResolvedValue({ id: "tpl1", tenantId: "tn1" } as any)
    vi.mocked(prisma.conversation.findUniqueOrThrow).mockResolvedValue({ contactId: "ct1" } as any)
    vi.mocked(canSendTx).mockResolvedValue({ ok: true, basis: "SERVICE_COMMS_NCA", evidence: "x" } as any)
    vi.mocked(resolveProvider).mockResolvedValue("BULKSMS" as any)
    vi.mocked(dispatch).mockRejectedValue(
      new ProviderDispatchError("BulkSMS error code 1001: invalid number", "DEFINITELY_REJECTED"),
    )
    txMock.message.update.mockResolvedValue({} as any)

    const r = await processRetryBatch({ limit: 50, now: new Date() })

    expect(r.failedPermanent).toBe(1)
  })

  it("reschedules to next backoff on TRANSIENT with attempts remaining", async () => {
    const retrying = { ...baseMessage, retryCount: 2 } // 3rd attempt → 4th in 30m
    txMock.message.updateMany.mockResolvedValue({ count: 0 } as any)
    txMock.message.findMany.mockResolvedValue([retrying])
    vi.mocked(prisma.messageTemplate.findUniqueOrThrow).mockResolvedValue({ id: "tpl1", tenantId: "tn1" } as any)
    vi.mocked(prisma.conversation.findUniqueOrThrow).mockResolvedValue({ contactId: "ct1" } as any)
    vi.mocked(canSendTx).mockResolvedValue({ ok: true, basis: "SERVICE_COMMS_NCA", evidence: "x" } as any)
    vi.mocked(resolveProvider).mockResolvedValue("BULKSMS" as any)
    vi.mocked(dispatch).mockRejectedValue(
      new ProviderDispatchError("502 Bad Gateway", "DEFINITELY_REJECTED"),
    )
    txMock.message.update.mockResolvedValue({} as any)

    const sweepNow = new Date("2026-05-22T10:00:00Z")
    const failureClock = new Date("2026-05-22T10:41:00Z")
    vi.useFakeTimers()
    vi.setSystemTime(failureClock)

    const r = await processRetryBatch({ limit: 50, now: sweepNow })

    expect(r.rescheduled).toBe(1)
    // retryCount in DB is 2 → newRetryCount = 3. nextBackoffMs = backoff(2) = 1_800_000 (30m).
    expect(globalMessageMock.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "msg1" }),
        data: expect.objectContaining({
          status: "RETRYING",
          retryCount: 3,
          nextRetryAt: new Date(failureClock.getTime() + 1_800_000),
          errorClass: "TRANSIENT",
        }),
      })
    )
    vi.useRealTimers()
  })
})

// ── Retry hardening trio (advisory lock, EXPIRED_SWEEP audit, tighter catch) ──
//
// The sweep wraps its body in `prisma.$transaction(async (tx) => ...)` so
// every query goes through `tx` (= `txMock`). The lock-acquire query is
// `tx.$queryRaw` — configure that one on `txMock.$queryRaw`.

import { Prisma } from "@prisma/client"

describe("processRetryBatch — PR-2.5 hardenings", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Restore the routing of $transaction back to the shared txMock (cleared
    // above) so the sweep body still receives the same set of model mocks.
    vi.mocked(prisma.$transaction).mockImplementation(async (cb: any, options?: any) => (
      cb(options?.timeout ? txMock : globalTxMock)
    ))
    // Default lock-acquired behaviour after clearAllMocks wipes it.
    txMock.$queryRaw.mockResolvedValue([{ acquired: true }])
    txMock.messageTemplate.findUniqueOrThrow.mockReset().mockResolvedValue({
      id: "tpl1",
      tenantId: "tn1",
    } as any)
    txMock.conversation.findUniqueOrThrow.mockReset().mockResolvedValue({
      contactId: "ct1",
      tenantId: "tn1",
    } as any)
    txMock.contact.findUniqueOrThrow.mockReset().mockResolvedValue({
      id: "ct1",
      tenantId: "tn1",
    } as any)
    txMock.auditLog.create.mockReset().mockResolvedValue({} as any)
    txMock.notificationLog.updateMany.mockResolvedValue({ count: 0 } as any)
    globalMessageMock.updateMany.mockResolvedValue({ count: 1 } as any)
    globalMessageMock.findFirst.mockResolvedValue(null)
    globalMessageMock.findFirstOrThrow.mockResolvedValue({ ...baseMessage, status: "SENT" } as any)
    globalTxMock.auditLog.create.mockResolvedValue({} as any)
  })

  it("returns zero counts and skips work when pg_try_advisory_xact_lock returns acquired=false", async () => {
    txMock.$queryRaw.mockResolvedValueOnce([{ acquired: false }])

    const r = await processRetryBatch({ limit: 50, now: new Date() })

    expect(r).toEqual({
      scanned: 0, expired: 0, suppressed: 0, dispatched: 0, simulated: 0,
      manualReconciliation: 0, rescheduled: 0, failedPermanent: 0,
    })
    // No DB work attempted
    expect(txMock.message.updateMany).not.toHaveBeenCalled()
    expect(txMock.message.findMany).not.toHaveBeenCalled()
  })

  it("writes MESSAGE_EXPIRED_SWEEP audit when the bulk-expire moved >0 rows", async () => {
    txMock.message.updateMany.mockResolvedValue({ count: 7 } as any)
    txMock.message.findMany.mockResolvedValue([])

    await processRetryBatch({ limit: 50, now: new Date() })

    const sweepAudit = vi.mocked(logAudit).mock.calls.find(
      (c: any[]) => c[0].action === "MESSAGE_EXPIRED_SWEEP"
    )
    expect(sweepAudit).toBeDefined()
    expect((sweepAudit?.[0] as any)?.newValue.count).toBe(7)
  })

  it("does NOT write MESSAGE_EXPIRED_SWEEP when bulk-expire moved 0 rows", async () => {
    txMock.message.updateMany.mockResolvedValue({ count: 0 } as any)
    txMock.message.findMany.mockResolvedValue([])

    await processRetryBatch({ limit: 50, now: new Date() })

    const sweepAudit = vi.mocked(logAudit).mock.calls.find(
      (c: any[]) => c[0].action === "MESSAGE_EXPIRED_SWEEP"
    )
    expect(sweepAudit).toBeUndefined()
  })

  it("inner-catch: TRANSIENT classification reschedules instead of FAILED_PERMANENT", async () => {
    txMock.message.updateMany
      .mockResolvedValueOnce({ count: 0 } as any)
      .mockResolvedValueOnce({ count: 1 } as any)
    txMock.message.findMany.mockResolvedValue([baseMessage])
    txMock.messageTemplate.findUniqueOrThrow.mockRejectedValue(
      new Error("502 Bad Gateway: upstream timeout"),
    )
    txMock.message.update.mockResolvedValue({} as any)

    const now = new Date("2026-05-22T10:00:00Z")
    const r = await processRetryBatch({ limit: 50, now })

    expect(r.rescheduled).toBe(1)
    expect(r.failedPermanent).toBe(0)
    expect(txMock.message.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "msg1", tenantId: "tn1", status: "RETRYING" }),
        data: expect.objectContaining({
          status: "RETRYING",
          retryCount: 2,
          errorClass: "TRANSIENT",
        }),
      })
    )
    expect(txMock.notificationLog.updateMany).toHaveBeenCalledWith({
      where: { tenantId: "tn1", messageId: "msg1" },
      data: { status: "pending", error: "502 Bad Gateway: upstream timeout" },
    })
  })

  it("inner-catch: a missing tenant-scoped template is terminally integrity-blocked", async () => {
    // The canonical inner-catch trigger: template deleted between scheduling
    // and retry. classifyError has no Prisma awareness — without the explicit
    // P2025 check this would burn 5 retries. Verifies the fix.
    txMock.message.updateMany
      .mockResolvedValueOnce({ count: 0 } as any)
      .mockResolvedValueOnce({ count: 1 } as any)
    txMock.message.findMany.mockResolvedValue([baseMessage])
    const prismaErr = new Prisma.PrismaClientKnownRequestError(
      "No record was found",
      { code: "P2025", clientVersion: "5.0.0" },
    )
    txMock.messageTemplate.findUniqueOrThrow.mockRejectedValue(prismaErr)
    txMock.message.update.mockResolvedValue({} as any)

    const r = await processRetryBatch({ limit: 50, now: new Date() })

    expect(r.failedPermanent).toBe(1)
    expect(r.rescheduled).toBe(0)
    expect(txMock.message.update).not.toHaveBeenCalled()
    expect(txMock.message.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: "msg1", tenantId: "tn1", status: "RETRYING" }),
      data: expect.objectContaining({
        status: "FAILED_PERMANENT",
        errorClass: "TENANT_INTEGRITY",
      }),
    }))
    expect(txMock.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "MESSAGE_RETRY_SUPPRESSED_TENANT_INTEGRITY",
        newValue: expect.objectContaining({ invalidRelation: "template" }),
      }),
    })
  })

  it("inner-catch: provider-shaped PERMANENT errors still terminate as FAILED_PERMANENT", async () => {
    txMock.message.updateMany
      .mockResolvedValueOnce({ count: 0 } as any)
      .mockResolvedValueOnce({ count: 1 } as any)
    txMock.message.findMany.mockResolvedValue([baseMessage])
    txMock.messageTemplate.findUniqueOrThrow.mockRejectedValue(
      new Error("BulkSMS error code 1001: invalid number"),
    )
    txMock.message.update.mockResolvedValue({} as any)

    const r = await processRetryBatch({ limit: 50, now: new Date() })

    expect(r.failedPermanent).toBe(1)
    expect(r.rescheduled).toBe(0)
    expect(txMock.notificationLog.updateMany).toHaveBeenCalledWith({
      where: { tenantId: "tn1", messageId: "msg1" },
      data: { status: "failed", error: "BulkSMS error code 1001: invalid number" },
    })
  })

  it("inner-catch: TRANSIENT with retries exhausted (retryCount=5) terminates as FAILED_PERMANENT", async () => {
    const exhausted = { ...baseMessage, retryCount: 5 }
    txMock.message.updateMany
      .mockResolvedValueOnce({ count: 0 } as any)
      .mockResolvedValueOnce({ count: 1 } as any)
    txMock.message.findMany.mockResolvedValue([exhausted])
    txMock.messageTemplate.findUniqueOrThrow.mockRejectedValue(new Error("502 Bad Gateway"))
    txMock.message.update.mockResolvedValue({} as any)

    const r = await processRetryBatch({ limit: 50, now: new Date() })

    expect(r.failedPermanent).toBe(1)
    expect(r.rescheduled).toBe(0)
    expect(txMock.notificationLog.updateMany).toHaveBeenCalledWith({
      where: { tenantId: "tn1", messageId: "msg1" },
      data: { status: "failed", error: "502 Bad Gateway" },
    })
  })

  it("logs a console.warn when the lock is busy (ops visibility, not silent skip)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    txMock.$queryRaw.mockResolvedValueOnce([{ acquired: false }])

    await processRetryBatch({ limit: 50, now: new Date() })

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("sweep skipped"),
    )
    warnSpy.mockRestore()
  })
})

describe("processRetryBatch — WA_CLOUD 24h service window", () => {
  const waMessage = {
    ...baseMessage,
    channel: "WHATSAPP",
    provider: "WA_CLOUD",
    toValue: "27821234567",
  } as any

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(prisma.$transaction).mockImplementation(async (cb: any, options?: any) => (
      cb(options?.timeout ? txMock : globalTxMock)
    ))
    txMock.$queryRaw.mockResolvedValue([{ acquired: true }])
    txMock.messageTemplate.findUniqueOrThrow.mockReset().mockResolvedValue({
      id: "tpl1",
      tenantId: "tn1",
    } as any)
    txMock.conversation.findUniqueOrThrow.mockReset().mockResolvedValue({
      contactId: "ct1",
      tenantId: "tn1",
    } as any)
    txMock.contact.findUniqueOrThrow.mockReset().mockResolvedValue({
      id: "ct1",
      tenantId: "tn1",
    } as any)
    txMock.auditLog.create.mockReset().mockResolvedValue({} as any)
    txMock.notificationLog.updateMany.mockResolvedValue({ count: 0 } as any)
    txMock.message.updateMany.mockResolvedValue({ count: 1 } as any)
    txMock.message.findMany.mockResolvedValue([waMessage])
    globalMessageMock.updateMany.mockResolvedValue({ count: 1 } as any)
    globalMessageMock.findFirst.mockResolvedValue(null)
    globalMessageMock.findFirstOrThrow.mockResolvedValue({ ...waMessage, status: "SENT" } as any)
    globalTxMock.auditLog.create.mockResolvedValue({} as any)
    vi.mocked(canSendTx).mockResolvedValue({
      ok: true, basis: "SERVICE_COMMS_NCA", evidence: "x",
    } as any)
    vi.mocked(resolveProvider).mockResolvedValue("WA_CLOUD" as any)
  })

  // The cloud sender reads the 24h window off the Contact — it has no other
  // source. Without contactId it sees lastInboundAt = null, which is
  // indistinguishable from "this person has never messaged us", so a reply to
  // someone who messaged a minute ago is rejected as out-of-window. This
  // double reproduces that decision (lib/whatsapp-cloud.ts:69-75); it is the
  // provider boundary, not the code under test.
  function windowAwareDispatch() {
    vi.mocked(dispatch).mockImplementation(async (_channel, _provider, _rendered, opts: any) => {
      const inWindow = opts.contactId === "ct1"          // contact's last inbound: 1 min ago
      if (!inWindow && !opts.waTemplate) {
        throw new ProviderDispatchError(
          WA_OUTSIDE_WINDOW_NEEDS_TEMPLATE,
          "DEFINITELY_REJECTED",
        )
      }
      return { providerMessageId: "wamid.retry1", acceptedAt: new Date("2026-08-12T10:00:00.000Z") }
    })
  }

  it("retries in-window as free text instead of failing WA_OUTSIDE_WINDOW_NEEDS_TEMPLATE", async () => {
    windowAwareDispatch()

    const r = await processRetryBatch({ limit: 50, now: new Date() })

    expect(r.dispatched).toBe(1)
    expect(r.failedPermanent).toBe(0)
    expect(globalMessageMock.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "SENT",
          providerMessageId: "wamid.retry1",
        }),
      }),
    )
  })

  it("passes the conversation's contactId across the provider boundary", async () => {
    windowAwareDispatch()

    await processRetryBatch({ limit: 50, now: new Date() })

    expect(dispatch).toHaveBeenCalledWith(
      "WHATSAPP",
      "WA_CLOUD",
      expect.anything(),
      expect.objectContaining({ tenantId: "tn1", contactId: "ct1" }),
    )
  })

  // Cross-tenant fail-closed for the contact is already covered by the
  // parametrised "fails closed before provider dispatch" case above, which
  // asserts dispatch is never reached — no need to restate it here.
})
