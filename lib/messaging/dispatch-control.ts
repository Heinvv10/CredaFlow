import { randomUUID } from "node:crypto"
import { Prisma, type Message, type MessageDispatchState, type MsgStatus } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { stringifyError } from "./errors"
import { MESSAGE_DISPATCH_LEASE_MS } from "./provider-timeout"
import { MESSAGE_RECONCILIATION_ERROR_CLASS } from "./reconciliation"

export class MessageDispatchConflictError extends Error {
  constructor() {
    super("Message dispatch attempt is no longer current")
    this.name = "MessageDispatchConflictError"
  }
}

export class MessageReconciliationRequiredError extends Error {
  readonly messageRecord: Message

  constructor(messageRecord: Message, detail = "Provider outcome requires manual reconciliation") {
    super(detail)
    this.name = "MessageReconciliationRequiredError"
    this.messageRecord = messageRecord
  }
}

export function reconciliationMessageFromError(error: unknown): Message | null {
  return error instanceof MessageReconciliationRequiredError ? error.messageRecord : null
}

export function validateMessageIdempotencyKey(key: string | undefined): string | null {
  if (key === undefined) return null
  const value = key.trim()
  if (value.length < 1 || value.length > 256 || /[\u0000-\u001F\u007F]/.test(value)) {
    throw new Error("Message idempotencyKey must be 1-256 characters without control characters")
  }
  return value
}

export function newMessageDispatchControl(now = new Date(), attempt = 1) {
  return {
    dispatchToken: randomUUID(),
    dispatchState: "DISPATCHING" as const,
    dispatchAttempt: attempt,
    dispatchStartedAt: now,
    dispatchLeaseExpiresAt: new Date(now.getTime() + MESSAGE_DISPATCH_LEASE_MS),
    dispatchCompletedAt: null,
    dispatchProviderMessageId: null,
    dispatchProviderAcceptedAt: null,
    dispatchEvidenceReference: null,
    reconciliationEvidenceReference: null,
    simulationReceiptId: null,
  }
}

type AuditArgs = {
  tenantId: string
  userId?: string
  userEmail?: string
  action: string
  messageId: string
  oldValue?: Record<string, unknown>
  newValue: Record<string, unknown>
}

async function createAtomicAudit(
  tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
  args: AuditArgs,
): Promise<void> {
  await tx.auditLog.create({
    data: {
      tenantId: args.tenantId,
      userId: args.userId ?? null,
      userEmail: args.userEmail ?? null,
      action: args.action,
      entity: "Message",
      entityId: args.messageId,
      oldValue: (args.oldValue ?? Prisma.JsonNull) as Prisma.InputJsonValue,
      newValue: args.newValue as Prisma.InputJsonValue,
    },
  })
}

export async function updateLinkedNotificationProjection(
  tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
  args: { tenantId: string; messageId: string; status: string; error: string | null },
): Promise<void> {
  await tx.notificationLog.updateMany({
    where: { tenantId: args.tenantId, messageId: args.messageId },
    data: { status: args.status, error: args.error },
  })
}

export async function completeMessageDispatch(args: {
  tenantId: string
  messageId: string
  dispatchToken: string
  providerMessageId?: string
  providerAcceptedAt?: Date
  evidenceReference?: string
  simulationReceiptId?: string
  // Channel value the provider reported the message as sent FROM. Only the
  // unofficial WhatsApp bridge supplies it, and only when it is running a
  // version that does: it fails over between numbers by itself, so this is the
  // per-message record of which number carried an NCA notice. Left untouched
  // when absent — a wrong sender is worse evidence than no sender.
  fromValue?: string
  simulated: boolean
  userId?: string
  auditExtra?: Record<string, unknown>
}): Promise<Message> {
  return prisma.$transaction(async (tx) => {
    if (args.simulated) {
      if (!args.simulationReceiptId) {
        throw new Error("A local simulation receipt is required for a simulated dispatch")
      }
      if (args.providerMessageId || args.providerAcceptedAt || args.evidenceReference) {
        throw new Error("A simulated dispatch cannot contain provider acceptance evidence")
      }
    } else {
      if (!args.providerAcceptedAt) {
        throw new Error("Provider acceptance time is required for an accepted dispatch")
      }
      if (!args.providerMessageId && !args.evidenceReference) {
        throw new Error("Provider message id or acceptance evidence is required for an accepted dispatch")
      }
      if (args.simulationReceiptId) {
        throw new Error("An accepted provider dispatch cannot contain a simulation receipt")
      }
    }
    const status: MsgStatus = args.simulated ? "SIMULATED" : "SENT"
    const state: MessageDispatchState = args.simulated ? "SIMULATED" : "ACCEPTED"
    const completedAt = new Date()
    // A dry-run completes locally without contacting a provider. The local
    // completion is dispatchCompletedAt; provider acceptance must remain null.
    const providerAcceptedAt = args.simulated ? null : args.providerAcceptedAt!
    const updated = await tx.message.updateMany({
      where: {
        id: args.messageId,
        tenantId: args.tenantId,
        status: "QUEUED",
        dispatchToken: args.dispatchToken,
        dispatchState: "DISPATCHING",
        dispatchLeaseExpiresAt: { gt: completedAt },
      },
      data: {
        status,
        sentAt: providerAcceptedAt,
        providerMessageId: args.simulated ? null : args.providerMessageId ?? null,
        dispatchState: state,
        dispatchProviderMessageId: args.simulated ? null : args.providerMessageId ?? null,
        dispatchProviderAcceptedAt: providerAcceptedAt,
        dispatchCompletedAt: completedAt,
        dispatchLeaseExpiresAt: null,
        dispatchEvidenceReference: args.simulated ? null : args.evidenceReference ?? null,
        // Only write when the provider actually told us; never overwrite a
        // known sender with null on a bridge that does not report one.
        ...(!args.simulated && args.fromValue ? { fromValue: args.fromValue } : {}),
        simulationReceiptId: args.simulated ? args.simulationReceiptId : null,
        nextRetryAt: null,
        errorClass: null,
        errorMessage: null,
      },
    })
    if (updated.count !== 1) {
      const current = await tx.message.findFirst({
        where: { id: args.messageId, tenantId: args.tenantId },
      })
      if (
        current &&
        current.dispatchToken === args.dispatchToken &&
        current.status === status &&
        current.dispatchState === state &&
        current.providerMessageId === (args.simulated ? null : args.providerMessageId ?? null) &&
        current.dispatchProviderMessageId === (args.simulated ? null : args.providerMessageId ?? null) &&
        current.dispatchEvidenceReference === (args.simulated ? null : args.evidenceReference ?? null) &&
        current.simulationReceiptId === (args.simulated ? args.simulationReceiptId : null) &&
        (providerAcceptedAt
          ? current.dispatchProviderAcceptedAt?.getTime() === providerAcceptedAt.getTime()
          : current.dispatchProviderAcceptedAt === null)
      ) {
        await updateLinkedNotificationProjection(tx, {
          tenantId: args.tenantId,
          messageId: args.messageId,
          status: args.simulated ? "simulated" : "sent",
          error: null,
        })
        if (!args.simulated) {
          await tx.conversation.updateMany({
            where: {
              id: current.conversationId,
              tenantId: args.tenantId,
              OR: [{ lastOutboundAt: null }, { lastOutboundAt: { lt: providerAcceptedAt! } }],
            },
            data: { lastOutboundAt: providerAcceptedAt! },
          })
          // lastActivityAt is the inbox queue's sort key and must move with
          // every write to lastInboundAt/lastOutboundAt. Its own guard, not the
          // one above: providerAcceptedAt can be older than an inbound that
          // landed while the dispatch was in flight, and writing it outright
          // would drag the thread backwards in the queue.
          await tx.conversation.updateMany({
            where: {
              id: current.conversationId,
              tenantId: args.tenantId,
              OR: [{ lastActivityAt: null }, { lastActivityAt: { lt: providerAcceptedAt! } }],
            },
            data: { lastActivityAt: providerAcceptedAt! },
          })
        }
        return current
      }
      throw new MessageDispatchConflictError()
    }

    await createAtomicAudit(tx, {
      tenantId: args.tenantId,
      userId: args.userId,
      action: args.simulated ? "MESSAGE_SIMULATED" : "MESSAGE_SENT",
      messageId: args.messageId,
      oldValue: { status: "QUEUED", dispatchState: "DISPATCHING", dispatchToken: args.dispatchToken },
      newValue: {
        status,
        dispatchState: state,
        providerMessageId: args.simulated ? null : args.providerMessageId ?? null,
        providerAcceptedAt: providerAcceptedAt?.toISOString() ?? null,
        providerEvidenceReference: args.simulated ? null : args.evidenceReference ?? null,
        simulationReceiptId: args.simulated ? args.simulationReceiptId : null,
        ...(args.simulated
          ? { simulationCompletedAt: completedAt.toISOString() }
          : { completedAt: completedAt.toISOString() }),
        simulated: args.simulated,
        ...(args.auditExtra ?? {}),
      },
    })
    await updateLinkedNotificationProjection(tx, {
      tenantId: args.tenantId,
      messageId: args.messageId,
      status: args.simulated ? "simulated" : "sent",
      error: null,
    })
    const message = await tx.message.findFirstOrThrow({ where: { id: args.messageId, tenantId: args.tenantId } })
    if (!args.simulated) {
      await tx.conversation.updateMany({
        where: {
          id: message.conversationId,
          tenantId: args.tenantId,
          OR: [{ lastOutboundAt: null }, { lastOutboundAt: { lt: providerAcceptedAt! } }],
        },
        data: { lastOutboundAt: providerAcceptedAt! },
      })
      // Inbox queue sort key — see the sibling bump above for why it carries
      // its own guard rather than riding on the lastOutboundAt one.
      await tx.conversation.updateMany({
        where: {
          id: message.conversationId,
          tenantId: args.tenantId,
          OR: [{ lastActivityAt: null }, { lastActivityAt: { lt: providerAcceptedAt! } }],
        },
        data: { lastActivityAt: providerAcceptedAt! },
      })
    }
    return message
  })
}

export async function holdMessageDispatchForReconciliation(args: {
  tenantId: string
  messageId: string
  dispatchToken: string
  state: "AMBIGUOUS" | "ACCEPTED" | "SIMULATED"
  reason: unknown
  providerMessageId?: string
  providerAcceptedAt?: Date
  evidenceReference?: string
  simulationReceiptId?: string
  userId?: string
  action: string
  auditExtra?: Record<string, unknown>
}): Promise<Message> {
  return prisma.$transaction(async (tx) => {
    const heldAt = new Date()
    const errorMessage = stringifyError(args.reason)
    if (args.state === "ACCEPTED") {
      if (!args.providerAcceptedAt) {
        throw new Error("Provider acceptance time is required for an accepted dispatch hold")
      }
      if (!args.providerMessageId && !args.evidenceReference) {
        throw new Error("Provider message id or acceptance evidence is required for an accepted dispatch hold")
      }
      if (args.simulationReceiptId) {
        throw new Error("An accepted dispatch hold cannot contain a simulation receipt")
      }
    }
    if (args.state === "SIMULATED") {
      if (!args.simulationReceiptId) {
        throw new Error("A local simulation receipt is required for a simulated dispatch hold")
      }
      if (args.providerMessageId || args.providerAcceptedAt || args.evidenceReference) {
        throw new Error("A simulated dispatch hold cannot contain provider acceptance evidence")
      }
    }
    const providerAcceptedAt = args.state === "ACCEPTED" ? args.providerAcceptedAt! : null
    const updated = await tx.message.updateMany({
      where: {
        id: args.messageId,
        tenantId: args.tenantId,
        status: "QUEUED",
        dispatchToken: args.dispatchToken,
        dispatchState: "DISPATCHING",
      },
      data: {
        dispatchState: args.state,
        dispatchProviderMessageId: args.state === "SIMULATED" ? null : args.providerMessageId ?? null,
        dispatchProviderAcceptedAt: providerAcceptedAt,
        dispatchEvidenceReference: args.state === "SIMULATED" ? null : args.evidenceReference ?? null,
        simulationReceiptId: args.state === "SIMULATED" ? args.simulationReceiptId : null,
        dispatchCompletedAt: heldAt,
        dispatchLeaseExpiresAt: null,
        nextRetryAt: null,
        errorClass: MESSAGE_RECONCILIATION_ERROR_CLASS,
        errorMessage,
        lastErrorAt: heldAt,
      },
    })
    if (updated.count !== 1) {
      const current = await tx.message.findFirst({
        where: { id: args.messageId, tenantId: args.tenantId },
      })
      if (
        current &&
        current.dispatchToken === args.dispatchToken &&
        current.status === "QUEUED" &&
        current.dispatchState === args.state &&
        current.dispatchProviderMessageId === (args.state === "SIMULATED" ? null : args.providerMessageId ?? null) &&
        current.dispatchEvidenceReference === (args.state === "SIMULATED" ? null : args.evidenceReference ?? null) &&
        current.simulationReceiptId === (args.state === "SIMULATED" ? args.simulationReceiptId : null) &&
        (providerAcceptedAt
          ? current.dispatchProviderAcceptedAt?.getTime() === providerAcceptedAt.getTime()
          : current.dispatchProviderAcceptedAt === null)
      ) {
        await updateLinkedNotificationProjection(tx, {
          tenantId: args.tenantId,
          messageId: args.messageId,
          status: "reconciliation_required",
          error: current.errorMessage,
        })
        return current
      }
      throw new MessageDispatchConflictError()
    }

    await createAtomicAudit(tx, {
      tenantId: args.tenantId,
      userId: args.userId,
      action: args.action,
      messageId: args.messageId,
      oldValue: { status: "QUEUED", dispatchState: "DISPATCHING", dispatchToken: args.dispatchToken },
      newValue: {
        status: "QUEUED",
        dispatchState: args.state,
        providerMessageId: args.state === "SIMULATED" ? null : args.providerMessageId ?? null,
        providerAcceptedAt: providerAcceptedAt?.toISOString() ?? null,
        providerEvidenceReference: args.state === "SIMULATED" ? null : args.evidenceReference ?? null,
        simulationReceiptId: args.state === "SIMULATED" ? args.simulationReceiptId : null,
        ...(args.state === "SIMULATED"
          ? { simulationCompletedAt: heldAt.toISOString() }
          : { completedAt: heldAt.toISOString() }),
        error: errorMessage,
        automaticReplayDisabled: true,
        ...(args.auditExtra ?? {}),
      },
    })
    await updateLinkedNotificationProjection(tx, {
      tenantId: args.tenantId,
      messageId: args.messageId,
      status: "reconciliation_required",
      error: errorMessage,
    })
    return tx.message.findFirstOrThrow({ where: { id: args.messageId, tenantId: args.tenantId } })
  })
}

export async function failMessageDispatchDefinitely(args: {
  tenantId: string
  messageId: string
  dispatchToken: string
  status: "RETRYING" | "FAILED_PERMANENT"
  retryCount: number
  nextRetryAt: Date | null
  errorClass: string
  error: unknown
  userId?: string
  auditExtra?: Record<string, unknown>
}): Promise<Message> {
  return prisma.$transaction(async (tx) => {
    const failedAt = new Date()
    const errorMessage = stringifyError(args.error)
    const updated = await tx.message.updateMany({
      where: {
        id: args.messageId,
        tenantId: args.tenantId,
        status: "QUEUED",
        dispatchToken: args.dispatchToken,
        dispatchState: "DISPATCHING",
      },
      data: {
        status: args.status,
        retryCount: args.retryCount,
        nextRetryAt: args.nextRetryAt,
        errorClass: args.errorClass,
        errorMessage,
        lastErrorAt: failedAt,
        dispatchState: "DEFINITELY_REJECTED",
        dispatchCompletedAt: failedAt,
        dispatchLeaseExpiresAt: null,
      },
    })
    if (updated.count !== 1) throw new MessageDispatchConflictError()
    await createAtomicAudit(tx, {
      tenantId: args.tenantId,
      userId: args.userId,
      action: args.status === "RETRYING" ? "MESSAGE_RETRY_SCHEDULED" : "MESSAGE_FAILED",
      messageId: args.messageId,
      oldValue: { status: "QUEUED", dispatchState: "DISPATCHING", dispatchToken: args.dispatchToken },
      newValue: {
        status: args.status,
        dispatchState: "DEFINITELY_REJECTED",
        retryCount: args.retryCount,
        nextRetryAt: args.nextRetryAt?.toISOString() ?? null,
        errorClass: args.errorClass,
        error: errorMessage,
        ...(args.auditExtra ?? {}),
      },
    })
    await updateLinkedNotificationProjection(tx, {
      tenantId: args.tenantId,
      messageId: args.messageId,
      status: args.status === "RETRYING" ? "pending" : "failed",
      error: errorMessage,
    })
    return tx.message.findFirstOrThrow({ where: { id: args.messageId, tenantId: args.tenantId } })
  })
}

/**
 * Statutory sends retain attachments and their legal reservation in the owning
 * workflow (for example Section 129). Close the generic Message attempt so the
 * body-only retry/reconciliation tools cannot act on it; the owner receives the
 * thrown provider error and records its own known-not-sent/uncertain outcome.
 */
export async function closeExternallyOwnedMessageDispatch(args: {
  tenantId: string
  messageId: string
  dispatchToken: string
  providerOutcome: "DEFINITELY_REJECTED" | "AMBIGUOUS"
  errorClass: string
  error: unknown
  retryCount: number
  userId?: string
}): Promise<Message> {
  return prisma.$transaction(async (tx) => {
    const completedAt = new Date()
    const errorMessage = stringifyError(args.error)
    const dispatchState: MessageDispatchState = args.providerOutcome === "AMBIGUOUS"
      ? "AMBIGUOUS"
      : "DEFINITELY_REJECTED"
    const updated = await tx.message.updateMany({
      where: {
        id: args.messageId,
        tenantId: args.tenantId,
        status: "QUEUED",
        dispatchToken: args.dispatchToken,
        dispatchState: "DISPATCHING",
      },
      data: {
        status: "FAILED_PERMANENT",
        retryCount: args.retryCount,
        nextRetryAt: null,
        errorClass: `${args.errorClass}_${args.providerOutcome === "AMBIGUOUS" ? "REQUIRES_RECONCILIATION" : "KNOWN_NOT_SENT"}`,
        errorMessage,
        lastErrorAt: completedAt,
        dispatchState,
        dispatchCompletedAt: completedAt,
        dispatchLeaseExpiresAt: null,
      },
    })
    if (updated.count !== 1) throw new MessageDispatchConflictError()
    await createAtomicAudit(tx, {
      tenantId: args.tenantId,
      userId: args.userId,
      action: args.providerOutcome === "AMBIGUOUS"
        ? "MESSAGE_DISPATCH_FAILED_RECONCILIATION_REQUIRED"
        : "MESSAGE_DISPATCH_KNOWN_NOT_SENT",
      messageId: args.messageId,
      oldValue: { status: "QUEUED", dispatchState: "DISPATCHING", dispatchToken: args.dispatchToken },
      newValue: {
        status: "FAILED_PERMANENT",
        dispatchState,
        providerOutcome: args.providerOutcome,
        errorClass: args.errorClass,
        error: errorMessage,
        automaticRetrySuppressed: true,
        reconciliationOwner: "CALLING_WORKFLOW",
      },
    })
    await updateLinkedNotificationProjection(tx, {
      tenantId: args.tenantId,
      messageId: args.messageId,
      status: args.providerOutcome === "AMBIGUOUS" ? "reconciliation_required" : "failed",
      error: errorMessage,
    })
    return tx.message.findFirstOrThrow({ where: { id: args.messageId, tenantId: args.tenantId } })
  })
}
