import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Message, MessageTemplate } from "@prisma/client"

const {
  sendMessageMock,
  executeRawMock,
  identityFindFirstMock,
  contactCreateMock,
  contactFindFirstMock,
  contactUpdateMock,
  identityCreateMock,
  templateUpsertMock,
  messageFindUniqueMock,
  notificationUpsertMock,
  auditCreateManyMock,
  transactionMock,
} = vi.hoisted(() => ({
  sendMessageMock: vi.fn(),
  executeRawMock: vi.fn(),
  identityFindFirstMock: vi.fn(),
  contactCreateMock: vi.fn(),
  contactFindFirstMock: vi.fn(),
  contactUpdateMock: vi.fn(),
  identityCreateMock: vi.fn(),
  templateUpsertMock: vi.fn(),
  messageFindUniqueMock: vi.fn(),
  notificationUpsertMock: vi.fn(),
  auditCreateManyMock: vi.fn(),
  transactionMock: vi.fn(),
}))

const tx = {
  $executeRawUnsafe: (...args: unknown[]) => executeRawMock(...args),
  contactIdentity: {
    findFirst: (args: unknown) => identityFindFirstMock(args),
    create: (args: unknown) => identityCreateMock(args),
  },
  contact: {
    findFirst: (args: unknown) => contactFindFirstMock(args),
    update: (args: unknown) => contactUpdateMock(args),
    create: (args: unknown) => contactCreateMock(args),
  },
  notificationLog: { upsert: (args: unknown) => notificationUpsertMock(args) },
  auditLog: { createMany: (args: unknown) => auditCreateManyMock(args) },
}

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: (...args: unknown[]) => transactionMock(...args),
    messageTemplate: { upsert: (args: unknown) => templateUpsertMock(args) },
    message: { findUnique: (args: unknown) => messageFindUniqueMock(args) },
  },
}))
vi.mock("./send", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./send")>()
  return { ...actual, sendMessage: (...args: unknown[]) => sendMessageMock(...args) }
})
vi.mock("@/lib/notifications", () => ({
  sanitizeNotificationLogError: (value?: string) => value,
}))

import { KnownDispatchPersistenceError, MessageReconciliationRequiredError } from "./send"
import { sendStaffTaskReminder } from "./staff-task-reminder"

const DUE = new Date("2026-07-22T09:00:00.000Z")
const template = {
  id: "template-1",
  tenantId: "tenant-1",
  key: "lead_task_reminder_email",
  event: "lead_task_reminder_email",
  channel: "EMAIL",
  category: "TRANSACTIONAL",
  product: "GENERAL",
  statutoryOverride: false,
  subject: "{{subject}}",
  body: "{{body}}",
  bodyTemplate: "{{bodyHtml}}",
  active: true,
  purposeRequired: null,
  language: "en",
} as unknown as MessageTemplate

function message(overrides: Record<string, unknown> = {}) {
  return {
    id: "message-1",
    tenantId: "tenant-1",
    conversationId: "conversation-1",
    status: "SENT",
    dispatchState: "ACCEPTED",
    errorClass: null,
    errorMessage: null,
    ...overrides,
  } as unknown as Message
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    tenantId: "tenant-1",
    taskId: "task-1",
    leadId: "lead-1",
    dueAt: DUE,
    recipientUserId: "user-1",
    recipientName: "Synthetic Staff",
    recipientEmail: "Staff@Example.Test",
    channel: "EMAIL" as const,
    toValue: " Staff@Example.Test ",
    subject: "Task due",
    text: "Open the task",
    html: "<p>Open the task</p>",
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  transactionMock.mockImplementation(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx))
  executeRawMock.mockResolvedValue(1)
  identityFindFirstMock.mockResolvedValue({
    contactId: "contact-1",
    contact: {
      id: "contact-1",
      status: "STAFF",
      firstSeenContext: "staff_task_reminder:user-1",
    },
  })
  contactCreateMock.mockResolvedValue({ id: "contact-new" })
  contactFindFirstMock.mockResolvedValue(null)
  contactUpdateMock.mockResolvedValue({ id: "contact-existing" })
  identityCreateMock.mockResolvedValue({ id: "identity-new" })
  templateUpsertMock.mockResolvedValue(template)
  messageFindUniqueMock.mockResolvedValue(null)
  notificationUpsertMock.mockResolvedValue({ id: "notification-1" })
  auditCreateManyMock.mockResolvedValue({ count: 1 })
  sendMessageMock.mockResolvedValue(message())
})

describe("sendStaffTaskReminder", () => {
  it("uses a deterministic Message reservation and atomically links projection + audit", async () => {
    const result = await sendStaffTaskReminder(input())

    expect(result).toEqual({ outcome: "sent", recorded: true, messageId: "message-1" })
    expect(sendMessageMock).toHaveBeenCalledWith(expect.objectContaining({
      contactId: "contact-1",
      channel: "EMAIL",
      toValue: "staff@example.test",
      category: "lead_task_reminder",
      idempotencyKey: "lead-task-reminder:task-1:2026-07-22T09:00:00.000Z:EMAIL",
    }))
    expect(notificationUpsertMock).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        id: "lead-task-reminder:tenant-1:task-1:2026-07-22T09:00:00.000Z:EMAIL",
        tenantId: "tenant-1",
      },
      create: expect.objectContaining({
      tenantId: "tenant-1",
      event: "lead_task_reminder",
      channel: "email",
      status: "sent",
      messageId: "message-1",
      }),
    }))
    expect(auditCreateManyMock).toHaveBeenCalledWith({
      data: [expect.objectContaining({
      action: "LEAD_TASK_REMINDER_SENT",
      entityId: "task-1",
      newValue: expect.objectContaining({
        leadId: "lead-1",
        messageId: "message-1",
        dispatchState: "ACCEPTED",
        outcome: "sent",
      }),
      })],
      skipDuplicates: true,
    })
    // contact resolution and projection are separate transactions; within the
    // projection transaction both writes share the same callback client.
    expect(transactionMock).toHaveBeenCalledTimes(2)
  })

  it("creates a STAFF contact under a channel-identity lock on first use", async () => {
    identityFindFirstMock.mockResolvedValue(null)
    await sendStaffTaskReminder(input({
      channel: "WHATSAPP",
      toValue: "082 123 4567",
    }))

    expect(executeRawMock).toHaveBeenNthCalledWith(
      1,
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      "staff-reminder-contact:tenant-1:user-1",
    )
    expect(executeRawMock).toHaveBeenNthCalledWith(
      2,
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      "staff-reminder:tenant-1:WHATSAPP:27821234567@s.whatsapp.net",
    )
    expect(contactCreateMock).toHaveBeenCalledWith({ data: expect.objectContaining({
      tenantId: "tenant-1",
      status: "STAFF",
      firstSeenChannel: "WHATSAPP",
      primaryWaJid: "27821234567@s.whatsapp.net",
    }) })
    expect(identityCreateMock).toHaveBeenCalledWith({ data: expect.objectContaining({
      channel: "WHATSAPP",
      value: "27821234567@s.whatsapp.net",
      verified: true,
    }) })
  })

  it("refuses an identity already owned by a customer instead of misrouting staff data", async () => {
    identityFindFirstMock.mockResolvedValue({
      contactId: "customer-contact",
      contact: { id: "customer-contact", status: "CLIENT" },
    })
    const result = await sendStaffTaskReminder(input())

    expect(sendMessageMock).not.toHaveBeenCalled()
    expect(result).toMatchObject({ outcome: "failed", recorded: true, messageId: null })
    expect(notificationUpsertMock).toHaveBeenCalledWith(expect.objectContaining({ create: expect.objectContaining({
      status: "failed",
      messageId: null,
    }) }))
  })

  it("refuses a staff identity owned by a different user", async () => {
    identityFindFirstMock.mockResolvedValue({
      contactId: "other-staff-contact",
      contact: {
        id: "other-staff-contact",
        status: "STAFF",
        firstSeenContext: "staff_task_reminder:user-2",
      },
    })

    const result = await sendStaffTaskReminder(input())

    expect(sendMessageMock).not.toHaveBeenCalled()
    expect(result).toMatchObject({
      outcome: "failed",
      recorded: true,
      messageId: null,
      error: expect.stringMatching(/different staff user/i),
    })
  })

  it("records simulation without claiming provider delivery", async () => {
    sendMessageMock.mockResolvedValue(message({
      status: "SIMULATED",
      dispatchState: "SIMULATED",
    }))
    const result = await sendStaffTaskReminder(input())

    expect(result.outcome).toBe("simulated")
    expect(notificationUpsertMock).toHaveBeenCalledWith(expect.objectContaining({ create: expect.objectContaining({ status: "simulated" }) }))
    expect(auditCreateManyMock).toHaveBeenCalledWith(expect.objectContaining({ data: [expect.objectContaining({
      action: "LEAD_TASK_REMINDER_SIMULATED",
    })] }))
  })

  it("projects ambiguous provider ownership as reconciliation-required", async () => {
    const held = message({
      status: "QUEUED",
      dispatchState: "AMBIGUOUS",
      errorClass: "RECONCILIATION_REQUIRED",
      errorMessage: "provider timed out",
    })
    sendMessageMock.mockRejectedValue(new MessageReconciliationRequiredError(held))
    const result = await sendStaffTaskReminder(input())

    expect(result).toMatchObject({
      outcome: "reconciliation_required",
      recorded: true,
      messageId: "message-1",
      error: "provider timed out",
    })
    expect(notificationUpsertMock).toHaveBeenCalledWith(expect.objectContaining({ create: expect.objectContaining({
      status: "reconciliation_required",
      messageId: "message-1",
    }) }))
    expect(auditCreateManyMock).toHaveBeenCalledWith(expect.objectContaining({ data: [expect.objectContaining({
      action: "LEAD_TASK_REMINDER_RECONCILIATION_REQUIRED",
    })] }))
  })

  it("preserves known provider-acceptance evidence when both terminal writes fail", async () => {
    const stale = message({
      status: "QUEUED",
      dispatchState: "DISPATCHING",
      errorMessage: null,
    })
    sendMessageMock.mockRejectedValue(new KnownDispatchPersistenceError({
      outcome: "PROVIDER_ACCEPTED",
      message: stale,
      providerMessageId: "provider-message-1",
      evidenceReference: "MSGRAPH_REQUEST_ID:req-1;CLIENT_REQUEST_ID:client-1",
      firstWriteError: new Error("terminal write failed"),
      recoveryWriteError: new Error("recovery write failed"),
      holdWriteError: new Error("hold write failed"),
    }))

    const result = await sendStaffTaskReminder(input())

    expect(result).toMatchObject({
      outcome: "reconciliation_required",
      recorded: true,
      messageId: "message-1",
      error: expect.stringMatching(/provider accepted/i),
      knownDispatchEvidence: {
        outcome: "PROVIDER_ACCEPTED",
        providerMessageId: "provider-message-1",
        evidenceReference: "MSGRAPH_REQUEST_ID:req-1;CLIENT_REQUEST_ID:client-1",
      },
    })
    expect(messageFindUniqueMock).not.toHaveBeenCalled()
    expect(notificationUpsertMock).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ status: "reconciliation_required" }),
    }))
    expect(auditCreateManyMock).toHaveBeenCalledWith(expect.objectContaining({
      data: [expect.objectContaining({
        action: "LEAD_TASK_REMINDER_RECONCILIATION_REQUIRED",
        newValue: expect.objectContaining({
          knownDispatchEvidence: {
            outcome: "PROVIDER_ACCEPTED",
            providerMessageId: "provider-message-1",
            evidenceReference: "MSGRAPH_REQUEST_ID:req-1;CLIENT_REQUEST_ID:client-1",
          },
        }),
      })],
    }))
  })

  it("preserves a known simulation receipt when both terminal writes fail", async () => {
    const stale = message({
      status: "QUEUED",
      dispatchState: "DISPATCHING",
      errorMessage: null,
    })
    sendMessageMock.mockRejectedValue(new KnownDispatchPersistenceError({
      outcome: "SIMULATED",
      message: stale,
      simulationReceiptId: "dry-run-receipt-1",
      firstWriteError: new Error("terminal write failed"),
      recoveryWriteError: new Error("recovery write failed"),
      holdWriteError: new Error("hold write failed"),
    }))

    const result = await sendStaffTaskReminder(input())

    expect(result).toMatchObject({
      outcome: "reconciliation_required",
      recorded: true,
      messageId: "message-1",
      error: expect.stringMatching(/simulation completed/i),
      knownDispatchEvidence: {
        outcome: "SIMULATED",
        simulationReceiptId: "dry-run-receipt-1",
      },
    })
    expect(messageFindUniqueMock).not.toHaveBeenCalled()
    expect(auditCreateManyMock).toHaveBeenCalledWith(expect.objectContaining({
      data: [expect.objectContaining({
        action: "LEAD_TASK_REMINDER_RECONCILIATION_REQUIRED",
        newValue: expect.objectContaining({
          knownDispatchEvidence: {
            outcome: "SIMULATED",
            simulationReceiptId: "dry-run-receipt-1",
          },
        }),
      })],
    }))
  })

  it("recovers a durable Message after an unexpected throw before classifying the outcome", async () => {
    const durable = message({ status: "RETRYING", dispatchState: "DEFINITELY_REJECTED" })
    sendMessageMock.mockRejectedValue(new Error("terminal transition response lost"))
    messageFindUniqueMock.mockResolvedValue(durable)

    const result = await sendStaffTaskReminder(input())

    expect(messageFindUniqueMock).toHaveBeenCalledWith({ where: {
      tenantId_idempotencyKey: {
        tenantId: "tenant-1",
        idempotencyKey: "lead-task-reminder:task-1:2026-07-22T09:00:00.000Z:EMAIL",
      },
    } })
    expect(result).toMatchObject({ outcome: "pending", recorded: true, messageId: "message-1" })
  })

  it("rolls projection and audit together and surfaces an unrecorded outcome", async () => {
    auditCreateManyMock.mockRejectedValue(new Error("audit unavailable"))
    const result = await sendStaffTaskReminder(input())

    expect(result).toMatchObject({ outcome: "sent", recorded: false, messageId: "message-1" })
  })
})
