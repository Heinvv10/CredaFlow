import { beforeEach, describe, expect, it, vi } from "vitest"

const updateMany = vi.fn()
const findFirst = vi.fn()
const auditCreate = vi.fn()
const conversationUpdateMany = vi.fn()
const notificationUpdateMany = vi.fn()
const transaction = vi.fn()
const tx = {
  message: { findFirst, updateMany },
  conversation: { updateMany: conversationUpdateMany },
  notificationLog: { updateMany: notificationUpdateMany },
  auditLog: { create: auditCreate },
}

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: (callback: (client: typeof tx) => Promise<unknown>) => transaction(callback),
  },
}))

import {
  MessageReconciliationConflictError,
  MessageReconciliationEvidenceError,
  reconcileHeldMessage,
} from "./reconcile-held-message"

const base = {
  tenantId: "tenant-1",
  messageId: "message-1",
  reason: "Provider delivery log checked by operations",
  evidenceReference: "provider-case-123",
  userId: "admin-1",
  userEmail: "admin@example.test",
}

describe("reconcileHeldMessage", () => {
  beforeEach(() => {
    vi.resetAllMocks()
    transaction.mockImplementation((callback: (client: typeof tx) => Promise<unknown>) => callback(tx))
    findFirst.mockResolvedValue({
      conversationId: "conversation-1",
      provider: "BULKSMS",
      errorClass: "RETRY_DISPATCH_CLAIMED_MANUAL_RECONCILIATION",
      createdAt: new Date("2026-07-22T13:00:00.000Z"),
      templateId: "template-1",
      dispatchToken: "attempt-1",
      dispatchState: "AMBIGUOUS",
      dispatchStartedAt: new Date("2026-07-22T13:59:00.000Z"),
      dispatchLeaseExpiresAt: null,
      dispatchProviderMessageId: null,
      dispatchProviderAcceptedAt: null,
      dispatchEvidenceReference: null,
      simulationReceiptId: null,
      idempotencyKey: "collections:loan-1:reminder:SMS:2026-07-22",
    })
    updateMany.mockResolvedValue({ count: 1 })
    auditCreate.mockResolvedValue({ id: "audit-1" })
    conversationUpdateMany.mockResolvedValue({ count: 1 })
    notificationUpdateMany.mockResolvedValue({ count: 1 })
  })

  it("records provider acceptance and its audit in one transaction", async () => {
    const acceptedAt = new Date("2026-07-22T14:00:00.000Z")
    await reconcileHeldMessage({
      ...base,
      outcome: "SENT",
      evidenceReference: "provider-case-123",
      providerMessageId: "provider-message-123",
      providerAcceptedAt: acceptedAt,
    })

    expect(updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: "message-1",
        tenantId: "tenant-1",
        status: "QUEUED",
        OR: expect.any(Array),
      }),
      data: expect.objectContaining({
        status: "SENT",
        sentAt: acceptedAt,
        providerMessageId: "provider-message-123",
        dispatchEvidenceReference: null,
        reconciliationEvidenceReference: "provider-case-123",
        errorClass: null,
        nextRetryAt: null,
      }),
    })
    expect(auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "MESSAGE_RECONCILED_SENT",
        entityId: "message-1",
        userId: "admin-1",
        newValue: expect.objectContaining({
          evidenceReference: "provider-case-123",
          providerMessageId: "provider-message-123",
          providerAcceptedAt: acceptedAt.toISOString(),
        }),
      }),
    })
    expect(conversationUpdateMany).toHaveBeenCalledWith({
      where: {
        id: "conversation-1",
        tenantId: "tenant-1",
        OR: [{ lastOutboundAt: null }, { lastOutboundAt: { lt: acceptedAt } }],
      },
      data: { lastOutboundAt: acceptedAt },
    })
    expect(notificationUpdateMany).toHaveBeenCalledWith({
      where: { tenantId: "tenant-1", messageId: "message-1" },
      data: { status: "sent", error: null },
    })
  })

  it("rejects provider acceptance that predates dispatch", async () => {
    await expect(reconcileHeldMessage({
      ...base,
      outcome: "SENT",
      providerMessageId: "provider-message-early",
      providerAcceptedAt: new Date("2026-07-22T13:58:59.999Z"),
    })).rejects.toThrow("cannot predate the message dispatch")

    expect(updateMany).not.toHaveBeenCalled()
    expect(conversationUpdateMany).not.toHaveBeenCalled()
    expect(auditCreate).not.toHaveBeenCalled()
  })

  it("resolves a crash-before-dispatch as terminal NOT_SENT without requeueing", async () => {
    await reconcileHeldMessage({ ...base, outcome: "NOT_SENT" })

    expect(updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: "FAILED_PERMANENT",
        errorClass: "RECONCILED_NOT_SENT",
        nextRetryAt: null,
        sentAt: null,
        providerMessageId: null,
        dispatchProviderMessageId: null,
        dispatchProviderAcceptedAt: null,
      }),
    }))
    expect(auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "MESSAGE_RECONCILED_NOT_SENT",
        newValue: expect.objectContaining({
          providerMessageId: null,
          providerAcceptedAt: null,
        }),
      }),
    })
    expect(notificationUpdateMany).toHaveBeenCalledWith({
      where: { tenantId: "tenant-1", messageId: "message-1" },
      data: {
        status: "failed",
        error: "Provider delivery log checked by operations",
      },
    })
  })

  it.each([
    { providerMessageId: "contradictory-provider-id" },
    { providerAcceptedAt: new Date("2026-07-22T14:00:00.000Z") },
  ])("rejects provider-acceptance evidence for NOT_SENT: %#", async (evidence) => {
    await expect(reconcileHeldMessage({ ...base, outcome: "NOT_SENT", ...evidence }))
      .rejects.toBeInstanceOf(MessageReconciliationEvidenceError)

    expect(transaction).not.toHaveBeenCalled()
    expect(updateMany).not.toHaveBeenCalled()
    expect(auditCreate).not.toHaveBeenCalled()
  })

  it("rejects a provider-acceptance timestamp for SIMULATED", async () => {
    await expect(reconcileHeldMessage({
      ...base,
      outcome: "SIMULATED",
      providerAcceptedAt: new Date("2026-07-22T14:00:00.000Z"),
    })).rejects.toBeInstanceOf(MessageReconciliationEvidenceError)

    expect(transaction).not.toHaveBeenCalled()
  })

  it("records a dry-run outcome as SIMULATED without a sent timestamp", async () => {
    await reconcileHeldMessage({
      ...base,
      outcome: "SIMULATED",
      evidenceReference: "dry-run-case-1",
      simulationReceiptId: "dry-run-receipt-1",
    })

    expect(updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: "SIMULATED",
        sentAt: null,
        providerMessageId: null,
        dispatchProviderMessageId: null,
        dispatchEvidenceReference: null,
        reconciliationEvidenceReference: "dry-run-case-1",
        simulationReceiptId: "dry-run-receipt-1",
      }),
    }))
    expect(notificationUpdateMany).toHaveBeenCalledWith({
      where: { tenantId: "tenant-1", messageId: "message-1" },
      data: { status: "simulated", error: null },
    })
  })

  it("rejects a manually reconciled simulation without a durable local receipt", async () => {
    await expect(reconcileHeldMessage({
      ...base,
      outcome: "SIMULATED",
    })).rejects.toThrow(/local simulation receipt/i)

    expect(updateMany).not.toHaveBeenCalled()
    expect(auditCreate).not.toHaveBeenCalled()
  })

  it("allows durable provider acceptance to become SENT only and preserves its evidence in the audit", async () => {
    const acceptedAt = new Date("2026-07-22T14:00:00.000Z")
    findFirst.mockResolvedValue({
      conversationId: "conversation-1",
      provider: "SMTP",
      errorClass: "PROVIDER_ACCEPTED_DB_WRITE_FAILED",
      createdAt: new Date("2026-07-22T13:00:00.000Z"),
      templateId: "template-1",
      dispatchToken: "attempt-accepted",
      dispatchState: "ACCEPTED",
      dispatchStartedAt: new Date("2026-07-22T13:59:00.000Z"),
      dispatchLeaseExpiresAt: null,
      dispatchProviderMessageId: "provider-accepted-1",
      dispatchProviderAcceptedAt: acceptedAt,
      dispatchEvidenceReference: null,
      simulationReceiptId: null,
      idempotencyKey: "business-event-1",
    })

    await expect(reconcileHeldMessage({ ...base, outcome: "NOT_SENT" }))
      .rejects.toBeInstanceOf(MessageReconciliationEvidenceError)
    expect(updateMany).not.toHaveBeenCalled()

    await reconcileHeldMessage({ ...base, outcome: "SENT" })

    expect(updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: "SENT",
        providerMessageId: "provider-accepted-1",
        sentAt: acceptedAt,
      }),
    }))
    expect(auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        oldValue: expect.objectContaining({
          dispatchState: "ACCEPTED",
          dispatchProviderMessageId: "provider-accepted-1",
          dispatchProviderAcceptedAt: acceptedAt.toISOString(),
        }),
      }),
    })
  })

  it("allows a durable dry-run outcome to become SIMULATED only", async () => {
    findFirst.mockResolvedValue({
      conversationId: "conversation-1",
      provider: "BULKSMS",
      errorClass: "SIMULATED_DB_WRITE_FAILED",
      createdAt: new Date("2026-07-22T13:00:00.000Z"),
      templateId: "template-1",
      dispatchToken: "attempt-simulated",
      dispatchState: "SIMULATED",
      dispatchStartedAt: new Date("2026-07-22T13:59:00.000Z"),
      dispatchLeaseExpiresAt: null,
      dispatchProviderMessageId: null,
      dispatchProviderAcceptedAt: null,
      dispatchEvidenceReference: null,
      simulationReceiptId: "dry-run-1",
      idempotencyKey: "business-event-2",
    })

    await expect(reconcileHeldMessage({
      ...base,
      outcome: "SENT",
      providerMessageId: "provider-fabricated",
      providerAcceptedAt: new Date("2026-07-22T14:00:00.000Z"),
    })).rejects.toBeInstanceOf(MessageReconciliationEvidenceError)
    expect(updateMany).not.toHaveBeenCalled()

    await expect(reconcileHeldMessage({
      ...base,
      outcome: "SIMULATED",
      providerMessageId: "dry-run-1",
      providerAcceptedAt: new Date("2026-07-22T14:01:00.000Z"),
    })).rejects.toBeInstanceOf(MessageReconciliationEvidenceError)
    expect(updateMany).not.toHaveBeenCalled()

    await reconcileHeldMessage({ ...base, outcome: "SIMULATED" })
    expect(updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: "SIMULATED",
        providerMessageId: null,
        dispatchProviderMessageId: null,
        dispatchProviderAcceptedAt: null,
        simulationReceiptId: "dry-run-1",
      }),
    }))
  })

  it("rejects a stale or already-resolved hold", async () => {
    findFirst.mockResolvedValue(null)
    await expect(reconcileHeldMessage({ ...base, outcome: "NOT_SENT" }))
      .rejects.toBeInstanceOf(MessageReconciliationConflictError)
    expect(auditCreate).not.toHaveBeenCalled()
  })

  it("allows only an expired persisted dispatch lease into the guarded action", async () => {
    findFirst.mockResolvedValue({
      errorClass: null,
      createdAt: new Date("2026-07-22T12:00:00.000Z"),
      templateId: "template-1",
      dispatchToken: "attempt-expired",
      dispatchState: "DISPATCHING",
      dispatchStartedAt: new Date("2026-07-22T11:59:00.000Z"),
      dispatchLeaseExpiresAt: new Date("2026-07-22T12:00:00.000Z"),
      dispatchProviderMessageId: null,
      dispatchProviderAcceptedAt: null,
      idempotencyKey: null,
    })

    await reconcileHeldMessage({ ...base, outcome: "NOT_SENT" })

    expect(auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        oldValue: expect.objectContaining({
          reconciliationSource: "EXPIRED_DISPATCH_LEASE",
          errorClass: null,
        }),
      }),
    })
  })

  it("rejects a candidate lost to a concurrent operator before the CAS update", async () => {
    updateMany.mockResolvedValue({ count: 0 })
    await expect(reconcileHeldMessage({ ...base, outcome: "NOT_SENT" }))
      .rejects.toBeInstanceOf(MessageReconciliationConflictError)
    expect(auditCreate).not.toHaveBeenCalled()
  })

  it("rolls the status change back when mandatory audit persistence fails", async () => {
    auditCreate.mockRejectedValue(new Error("audit unavailable"))
    transaction.mockImplementation(async (callback: (client: typeof tx) => Promise<unknown>) => {
      await expect(callback(tx)).rejects.toThrow("audit unavailable")
      throw new Error("transaction rolled back")
    })

    await expect(reconcileHeldMessage({ ...base, outcome: "NOT_SENT" }))
      .rejects.toThrow("transaction rolled back")
  })
})
