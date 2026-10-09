import { prisma } from "@/lib/prisma"
import {
  allowedMessageReconciliationOutcomes,
  MESSAGE_RECONCILIATION_ERROR_CLASS,
  messageReconciliationCandidateWhere,
  type MessageReconciliationOutcome,
} from "./reconciliation"

export type { MessageReconciliationOutcome } from "./reconciliation"

export class MessageReconciliationConflictError extends Error {
  constructor() {
    super("Message is not on the manual-reconciliation hold")
    this.name = "MessageReconciliationConflictError"
  }
}

export class MessageReconciliationEvidenceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "MessageReconciliationEvidenceError"
  }
}

export async function reconcileHeldMessage(args: {
  tenantId: string
  messageId: string
  outcome: MessageReconciliationOutcome
  reason: string
  evidenceReference: string
  providerMessageId?: string
  providerAcceptedAt?: Date
  simulationReceiptId?: string
  userId: string
  userEmail: string
}): Promise<void> {
  const reason = args.reason.trim()
  const evidenceReference = args.evidenceReference.trim()
  const suppliedSimulationReceiptId = args.simulationReceiptId?.trim()
  if (!reason) {
    throw new MessageReconciliationEvidenceError("A reconciliation reason is required")
  }
  if (!evidenceReference) {
    throw new MessageReconciliationEvidenceError("An evidence reference is required")
  }
  if (args.outcome !== "SENT" && args.providerAcceptedAt) {
    throw new MessageReconciliationEvidenceError(
      "Provider acceptance time is valid only when reconciling an outcome as SENT",
    )
  }
  if (args.outcome !== "SENT" && args.providerMessageId) {
    throw new MessageReconciliationEvidenceError(
      "Provider message ID is valid only when reconciling an outcome as SENT",
    )
  }
  if (args.outcome !== "SIMULATED" && suppliedSimulationReceiptId) {
    throw new MessageReconciliationEvidenceError(
      "Simulation receipt ID is valid only when reconciling an outcome as SIMULATED",
    )
  }
  if (
    suppliedSimulationReceiptId &&
    (suppliedSimulationReceiptId.length > 512 || /[\u0000-\u001F\u007F]/.test(suppliedSimulationReceiptId))
  ) {
    throw new MessageReconciliationEvidenceError(
      "Simulation receipt ID must be at most 512 characters without control characters",
    )
  }

  await prisma.$transaction(async (tx) => {
    const reconciledAt = new Date()
    const candidate = await tx.message.findFirst({
      where: {
        id: args.messageId,
        tenantId: args.tenantId,
        status: "QUEUED",
        ...messageReconciliationCandidateWhere(reconciledAt),
      },
      select: {
        conversationId: true,
        provider: true,
        errorClass: true,
        createdAt: true,
        templateId: true,
        dispatchToken: true,
        dispatchState: true,
        dispatchStartedAt: true,
        dispatchLeaseExpiresAt: true,
        dispatchProviderMessageId: true,
        dispatchProviderAcceptedAt: true,
        dispatchEvidenceReference: true,
        simulationReceiptId: true,
        idempotencyKey: true,
      },
    })
    if (!candidate) throw new MessageReconciliationConflictError()

    const allowedOutcomes = allowedMessageReconciliationOutcomes(candidate.dispatchState)
    if (!allowedOutcomes.includes(args.outcome)) {
      throw new MessageReconciliationEvidenceError(
        `A durable ${candidate.dispatchState ?? "UNKNOWN"} provider outcome cannot be reconciled as ${args.outcome}`,
      )
    }

    if (
      candidate.dispatchState === "ACCEPTED" &&
      args.providerMessageId &&
      args.providerMessageId !== candidate.dispatchProviderMessageId
    ) {
      throw new MessageReconciliationEvidenceError(
        "The supplied provider message ID contradicts the durable dispatch evidence",
      )
    }
    if (
      candidate.dispatchState === "ACCEPTED" &&
      args.providerAcceptedAt &&
      args.providerAcceptedAt.getTime() !== candidate.dispatchProviderAcceptedAt?.getTime()
    ) {
      throw new MessageReconciliationEvidenceError(
        "The supplied provider acceptance timestamp contradicts the durable dispatch evidence",
      )
    }

    const providerMessageId = args.outcome === "SENT"
      ? candidate.dispatchState === "ACCEPTED"
        ? candidate.dispatchProviderMessageId ?? undefined
        : args.providerMessageId ?? candidate.dispatchProviderMessageId ?? undefined
      : undefined
    const providerEvidenceReference = candidate.dispatchState === "ACCEPTED"
      ? candidate.dispatchEvidenceReference ?? undefined
      : args.outcome === "SENT" && candidate.provider === "MSGRAPH"
        ? evidenceReference
        : undefined
    if (args.outcome === "SENT" && !providerMessageId && !providerEvidenceReference) {
      throw new MessageReconciliationEvidenceError(
        "A provider message ID or durable provider acceptance evidence is required when reconciling an outcome as SENT",
      )
    }
    const providerAcceptedAt = args.outcome === "SENT"
      ? candidate.dispatchState === "ACCEPTED"
        ? candidate.dispatchProviderAcceptedAt ?? undefined
        : args.providerAcceptedAt
      : undefined
    if (args.outcome === "SENT" && !providerAcceptedAt) {
      throw new MessageReconciliationEvidenceError(
        "The provider acceptance timestamp is required when reconciling an outcome as SENT",
      )
    }
    if (args.outcome === "SENT") {
      const dispatchFloor = candidate.dispatchStartedAt ?? candidate.createdAt
      if (providerAcceptedAt!.getTime() < dispatchFloor.getTime()) {
        throw new MessageReconciliationEvidenceError(
          "The provider acceptance timestamp cannot predate the message dispatch",
        )
      }
      if (providerAcceptedAt!.getTime() > reconciledAt.getTime()) {
        throw new MessageReconciliationEvidenceError(
          "The provider acceptance timestamp cannot be in the future",
        )
      }
    }

    const reconciliationState = args.outcome === "SENT"
      ? "RECONCILED_SENT" as const
      : args.outcome === "SIMULATED"
        ? "RECONCILED_SIMULATED" as const
        : "RECONCILED_NOT_SENT" as const
    const simulationReceiptId = args.outcome === "SIMULATED"
      ? candidate.simulationReceiptId ?? suppliedSimulationReceiptId
      : undefined
    if (args.outcome === "SIMULATED" && !simulationReceiptId) {
      throw new MessageReconciliationEvidenceError(
        "A durable local simulation receipt is required when reconciling an outcome as SIMULATED",
      )
    }

    const update = await tx.message.updateMany({
      where: {
        id: args.messageId,
        tenantId: args.tenantId,
        status: "QUEUED",
        dispatchToken: candidate.dispatchToken,
        dispatchState: candidate.dispatchState,
        ...messageReconciliationCandidateWhere(reconciledAt),
      },
      data: args.outcome === "NOT_SENT"
        ? {
            status: "FAILED_PERMANENT",
            errorClass: "RECONCILED_NOT_SENT",
            errorMessage: reason,
            nextRetryAt: null,
            lastErrorAt: reconciledAt,
            sentAt: null,
            providerMessageId: null,
            dispatchState: reconciliationState,
            dispatchCompletedAt: reconciledAt,
            dispatchLeaseExpiresAt: null,
            dispatchProviderMessageId: null,
            dispatchProviderAcceptedAt: null,
            dispatchEvidenceReference: null,
            reconciliationEvidenceReference: evidenceReference,
            simulationReceiptId: null,
          }
        : {
            status: args.outcome,
            sentAt: args.outcome === "SENT" ? providerAcceptedAt : null,
            providerMessageId: args.outcome === "SENT" ? providerMessageId ?? null : null,
            errorClass: null,
            errorMessage: null,
            nextRetryAt: null,
            lastErrorAt: reconciledAt,
            dispatchState: reconciliationState,
            dispatchCompletedAt: reconciledAt,
            dispatchLeaseExpiresAt: null,
            dispatchProviderMessageId: args.outcome === "SENT" ? providerMessageId ?? null : null,
            dispatchProviderAcceptedAt: args.outcome === "SENT" ? providerAcceptedAt! : null,
            dispatchEvidenceReference: args.outcome === "SENT"
              ? providerEvidenceReference ?? null
              : null,
            reconciliationEvidenceReference: evidenceReference,
            simulationReceiptId: args.outcome === "SIMULATED"
              ? simulationReceiptId
              : null,
          },
    })
    if (update.count !== 1) throw new MessageReconciliationConflictError()

    await tx.notificationLog.updateMany({
      where: { tenantId: args.tenantId, messageId: args.messageId },
      data: args.outcome === "NOT_SENT"
        ? { status: "failed", error: reason }
        : {
            status: args.outcome === "SIMULATED" ? "simulated" : "sent",
            error: null,
          },
    })

    if (args.outcome === "SENT") {
      await tx.conversation.updateMany({
        where: {
          id: candidate.conversationId,
          tenantId: args.tenantId,
          OR: [{ lastOutboundAt: null }, { lastOutboundAt: { lt: providerAcceptedAt! } }],
        },
        data: { lastOutboundAt: providerAcceptedAt! },
      })
      // Inbox queue sort key — must move with every lastInboundAt/
      // lastOutboundAt write. Guarded independently: reconciliation runs well
      // after the fact, so providerAcceptedAt is routinely older than inbound
      // that has since landed, and an unguarded write would sink the thread.
      await tx.conversation.updateMany({
        where: {
          id: candidate.conversationId,
          tenantId: args.tenantId,
          OR: [{ lastActivityAt: null }, { lastActivityAt: { lt: providerAcceptedAt! } }],
        },
        data: { lastActivityAt: providerAcceptedAt! },
      })
    }

    await tx.auditLog.create({
      data: {
        tenantId: args.tenantId,
        userId: args.userId,
        userEmail: args.userEmail,
        action: `MESSAGE_RECONCILED_${args.outcome}`,
        entity: "Message",
        entityId: args.messageId,
        oldValue: {
          status: "QUEUED",
          errorClass: candidate.errorClass,
          createdAt: candidate.createdAt.toISOString(),
          templateId: candidate.templateId,
          dispatchToken: candidate.dispatchToken,
          dispatchState: candidate.dispatchState,
          dispatchStartedAt: candidate.dispatchStartedAt?.toISOString() ?? null,
          dispatchLeaseExpiresAt: candidate.dispatchLeaseExpiresAt?.toISOString() ?? null,
          dispatchProviderMessageId: candidate.dispatchProviderMessageId,
          dispatchProviderAcceptedAt: candidate.dispatchProviderAcceptedAt?.toISOString() ?? null,
          dispatchEvidenceReference: candidate.dispatchEvidenceReference,
          simulationReceiptId: candidate.simulationReceiptId,
          idempotencyKey: candidate.idempotencyKey,
          reconciliationSource: candidate.dispatchState === "DISPATCHING"
            ? "EXPIRED_DISPATCH_LEASE"
            : candidate.errorClass === MESSAGE_RECONCILIATION_ERROR_CLASS
              ? "EXPLICIT_HOLD"
              : "DURABLE_PROVIDER_OUTCOME",
          automaticReplayDisabled: true,
        },
        newValue: {
          outcome: args.outcome,
          reason,
          evidenceReference,
          providerMessageId: args.outcome === "SENT" ? providerMessageId ?? null : null,
          providerAcceptedAt: args.outcome === "SENT" ? providerAcceptedAt!.toISOString() : null,
          providerEvidenceReference: args.outcome === "SENT" ? providerEvidenceReference ?? null : null,
          simulationReceiptId: args.outcome === "SIMULATED" ? simulationReceiptId : null,
          reconciledAt: reconciledAt.toISOString(),
        },
      },
    })
  })
}
