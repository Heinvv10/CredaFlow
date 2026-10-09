/**
 * Real transaction proof for operator reconciliation. Run only against a
 * throwaway fully migrated PostgreSQL database:
 *
 *   RUN_MESSAGE_RECONCILIATION_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/messaging/reconcile-held-message.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { describe, expect, it } from "vitest"
import { prisma } from "@/lib/prisma"
import { withoutTenantScope } from "@/lib/tenant-scope"
import { MESSAGE_RECONCILIATION_ERROR_CLASS } from "./reconciliation"
import {
  MessageReconciliationEvidenceError,
  reconcileHeldMessage,
} from "./reconcile-held-message"

const RUN = process.env.RUN_MESSAGE_RECONCILIATION_IT === "1"
const suite = RUN ? describe : describe.skip

suite("held message reconciliation transaction", () => {
  it("commits the audited resolution and rolls back when the audit actor is invalid", async () => {
    const token = randomUUID().replaceAll("-", "")
    const tenantId = `tenant_message_reconcile_${token}`
    const contactId = `contact_message_reconcile_${token}`
    const conversationId = `conversation_message_reconcile_${token}`
    const userId = `user_message_reconcile_${token}`
    const templateId = `template_message_reconcile_${token}`
    const resolvedId = `message_resolved_${token}`
    const rollbackId = `message_rollback_${token}`
    const staleInitialId = `message_stale_initial_${token}`
    const freshInitialId = `message_fresh_initial_${token}`
    const acceptedId = `message_accepted_${token}`
    const simulatedId = `message_simulated_${token}`
    const now = new Date()
    const acceptedAt = new Date(now.getTime() - 30_000)

    await withoutTenantScope(async () => {
      await prisma.tenant.create({
        data: { id: tenantId, slug: `message-reconcile-${token}`, name: "Message reconciliation test" },
      })
      await prisma.user.create({
        data: {
          id: userId,
          tenantId,
          email: `message-reconcile-${token}@example.test`,
          password: "synthetic-test-only",
          role: "LOAN_ADMIN",
        },
      })
      await prisma.contact.create({
        data: { id: contactId, tenantId, firstSeenChannel: "SMS" },
      })
      await prisma.conversation.create({
        data: { id: conversationId, tenantId, contactId, channel: "SMS" },
      })
      await prisma.messageTemplate.create({
        data: {
          id: templateId,
          tenantId,
          event: `message_reconcile_${token}`,
          key: `message_reconcile_${token}`,
          channel: "SMS",
          body: "Synthetic reconciliation template",
          category: "SERVICE",
        },
      })
      await prisma.message.createMany({
        data: [resolvedId, rollbackId].map((id) => ({
          id,
          tenantId,
          conversationId,
          channel: "SMS" as const,
          direction: "OUTBOUND" as const,
          provider: "BULKSMS" as const,
          status: "QUEUED" as const,
          errorClass: MESSAGE_RECONCILIATION_ERROR_CLASS,
          errorMessage: "Retry dispatch claimed; automatic replay disabled",
          bodyText: "Synthetic reconciliation message",
          dispatchToken: `dispatch_${id}`,
          dispatchState: "AMBIGUOUS" as const,
          dispatchAttempt: 1,
          dispatchStartedAt: now,
          ...(id === resolvedId
            ? {
                dispatchProviderMessageId: `stale_provider_${token}`,
                dispatchProviderAcceptedAt: acceptedAt,
              }
            : {}),
        })),
      })
      await prisma.message.createMany({
        data: [
          {
            id: staleInitialId,
            tenantId,
            conversationId,
            channel: "SMS",
            direction: "OUTBOUND",
            provider: "BULKSMS",
            status: "QUEUED",
            templateId,
            bodyText: "Synthetic abandoned initial send",
            dispatchToken: `dispatch_${staleInitialId}`,
            dispatchState: "DISPATCHING",
            dispatchAttempt: 1,
            dispatchStartedAt: new Date(now.getTime() - 120_000),
            dispatchLeaseExpiresAt: new Date(now.getTime() - 60_000),
          },
          {
            id: freshInitialId,
            tenantId,
            conversationId,
            channel: "SMS",
            direction: "OUTBOUND",
            provider: "BULKSMS",
            status: "QUEUED",
            templateId,
            bodyText: "Synthetic active initial send",
            dispatchToken: `dispatch_${freshInitialId}`,
            dispatchState: "DISPATCHING",
            dispatchAttempt: 1,
            dispatchStartedAt: now,
            dispatchLeaseExpiresAt: new Date(now.getTime() + 60_000),
          },
        ],
      })
      await prisma.message.createMany({
        data: [
          {
            id: acceptedId,
            tenantId,
            conversationId,
            channel: "EMAIL",
            direction: "OUTBOUND",
            provider: "SMTP",
            status: "QUEUED",
            templateId,
            bodyText: "Synthetic accepted provider outcome",
            dispatchToken: `dispatch_${acceptedId}`,
            dispatchState: "ACCEPTED",
            dispatchAttempt: 1,
            dispatchStartedAt: new Date(now.getTime() - 60_000),
            dispatchCompletedAt: now,
            dispatchProviderMessageId: `provider_${acceptedId}`,
            dispatchProviderAcceptedAt: acceptedAt,
            errorClass: MESSAGE_RECONCILIATION_ERROR_CLASS,
          },
          {
            id: simulatedId,
            tenantId,
            conversationId,
            channel: "SMS",
            direction: "OUTBOUND",
            provider: "BULKSMS",
            status: "QUEUED",
            templateId,
            bodyText: "Synthetic simulated provider outcome",
            dispatchToken: `dispatch_${simulatedId}`,
            dispatchState: "SIMULATED",
            dispatchAttempt: 1,
            dispatchStartedAt: new Date(now.getTime() - 60_000),
            dispatchCompletedAt: now,
            simulationReceiptId: `dry-run_${simulatedId}`,
            dispatchProviderAcceptedAt: null,
            errorClass: MESSAGE_RECONCILIATION_ERROR_CLASS,
          },
        ],
      })
      await prisma.notificationLog.createMany({
        data: [
          { id: `notification_${resolvedId}`, tenantId, event: "synthetic", channel: "sms", status: "reconciliation_required", messageId: resolvedId },
          { id: `notification_${acceptedId}`, tenantId, event: "synthetic", channel: "email", status: "reconciliation_required", messageId: acceptedId },
          { id: `notification_${simulatedId}`, tenantId, event: "synthetic", channel: "sms", status: "reconciliation_required", messageId: simulatedId },
        ],
      })
    })

    await withoutTenantScope(() => reconcileHeldMessage({
      tenantId,
      messageId: resolvedId,
      outcome: "NOT_SENT",
      reason: "Provider logs confirm no request was accepted",
      evidenceReference: "provider-case-not-sent-1",
      userId,
      userEmail: `message-reconcile-${token}@example.test`,
    }))
    expect(await withoutTenantScope(() => prisma.message.findFirst({
      where: { id: resolvedId, tenantId },
      select: {
        status: true,
        errorClass: true,
        nextRetryAt: true,
        providerMessageId: true,
        dispatchProviderMessageId: true,
        dispatchProviderAcceptedAt: true,
      },
    }))).toEqual({
      status: "FAILED_PERMANENT",
      errorClass: "RECONCILED_NOT_SENT",
      nextRetryAt: null,
      providerMessageId: null,
      dispatchProviderMessageId: null,
      dispatchProviderAcceptedAt: null,
    })
    const notSentAudit = await withoutTenantScope(() => prisma.auditLog.findFirstOrThrow({
      where: {
        tenantId,
        entityId: resolvedId,
        action: "MESSAGE_RECONCILED_NOT_SENT",
      },
      select: { newValue: true },
    }))
    expect(notSentAudit.newValue).toEqual(expect.objectContaining({
      providerMessageId: null,
      providerAcceptedAt: null,
    }))
    expect(await withoutTenantScope(() => prisma.notificationLog.findFirst({
      where: { tenantId, messageId: resolvedId },
      select: { status: true, error: true },
    }))).toEqual({
      status: "failed",
      error: "Provider logs confirm no request was accepted",
    })

    await expect(withoutTenantScope(() => reconcileHeldMessage({
      tenantId,
      messageId: rollbackId,
      outcome: "NOT_SENT",
      reason: "Provider logs confirm no request was accepted",
      evidenceReference: "provider-case-not-sent-2",
      userId: `missing_${token}`,
      userEmail: "missing@example.test",
    }))).rejects.toThrow()
    expect(await withoutTenantScope(() => prisma.message.findFirst({
      where: { id: rollbackId, tenantId },
      select: { status: true, errorClass: true },
    }))).toEqual({
      status: "QUEUED",
      errorClass: MESSAGE_RECONCILIATION_ERROR_CLASS,
    })

    await withoutTenantScope(() => reconcileHeldMessage({
      tenantId,
      messageId: staleInitialId,
      outcome: "NOT_SENT",
      reason: "The abandoned initial send never reached the provider",
      evidenceReference: "worker-log-expired-1",
      userId,
      userEmail: `message-reconcile-${token}@example.test`,
    }))
    expect(await withoutTenantScope(() => prisma.message.findFirst({
      where: { id: staleInitialId, tenantId },
      select: { status: true, errorClass: true },
    }))).toEqual({
      status: "FAILED_PERMANENT",
      errorClass: "RECONCILED_NOT_SENT",
    })

    await expect(withoutTenantScope(() => reconcileHeldMessage({
      tenantId,
      messageId: freshInitialId,
      outcome: "NOT_SENT",
      reason: "This active send must not be captured by reconciliation",
      evidenceReference: "worker-log-active-1",
      userId,
      userEmail: `message-reconcile-${token}@example.test`,
    }))).rejects.toThrow("Message is not on the manual-reconciliation hold")
    expect(await withoutTenantScope(() => prisma.message.findFirst({
      where: { id: freshInitialId, tenantId },
      select: { status: true, errorClass: true },
    }))).toEqual({ status: "QUEUED", errorClass: null })

    await expect(withoutTenantScope(() => reconcileHeldMessage({
      tenantId,
      messageId: acceptedId,
      outcome: "NOT_SENT",
      reason: "This contradicts durable provider acceptance",
      evidenceReference: "operator-error-accepted-1",
      userId,
      userEmail: `message-reconcile-${token}@example.test`,
    }))).rejects.toBeInstanceOf(MessageReconciliationEvidenceError)
    expect(await withoutTenantScope(() => prisma.message.findFirst({
      where: { id: acceptedId, tenantId },
      select: {
        status: true,
        dispatchState: true,
        dispatchProviderMessageId: true,
        dispatchProviderAcceptedAt: true,
      },
    }))).toEqual({
      status: "QUEUED",
      dispatchState: "ACCEPTED",
      dispatchProviderMessageId: `provider_${acceptedId}`,
      dispatchProviderAcceptedAt: acceptedAt,
    })

    await expect(withoutTenantScope(() => reconcileHeldMessage({
      tenantId,
      messageId: simulatedId,
      outcome: "SENT",
      reason: "This contradicts a durable dry-run outcome",
      evidenceReference: "operator-error-simulated-1",
      providerMessageId: `fabricated_${simulatedId}`,
      providerAcceptedAt: now,
      userId,
      userEmail: `message-reconcile-${token}@example.test`,
    }))).rejects.toBeInstanceOf(MessageReconciliationEvidenceError)
    expect(await withoutTenantScope(() => prisma.message.findFirst({
      where: { id: simulatedId, tenantId },
      select: {
        status: true,
        dispatchState: true,
        dispatchProviderMessageId: true,
        dispatchProviderAcceptedAt: true,
      },
    }))).toEqual({
      status: "QUEUED",
      dispatchState: "SIMULATED",
      dispatchProviderMessageId: null,
      dispatchProviderAcceptedAt: null,
    })

    await expect(withoutTenantScope(() => reconcileHeldMessage({
      tenantId,
      messageId: simulatedId,
      outcome: "SIMULATED",
      reason: "This attempts to rewrite durable simulation evidence",
      evidenceReference: "operator-error-simulated-timestamp-1",
      providerMessageId: `provider_${simulatedId}`,
      providerAcceptedAt: now,
      userId,
      userEmail: `message-reconcile-${token}@example.test`,
    }))).rejects.toBeInstanceOf(MessageReconciliationEvidenceError)

    await withoutTenantScope(() => reconcileHeldMessage({
      tenantId,
      messageId: acceptedId,
      outcome: "SENT",
      reason: "Provider acceptance recovered from durable evidence",
      evidenceReference: "provider-case-accepted-1",
      userId,
      userEmail: `message-reconcile-${token}@example.test`,
    }))
    await withoutTenantScope(() => reconcileHeldMessage({
      tenantId,
      messageId: simulatedId,
      outcome: "SIMULATED",
      reason: "Dry-run result recovered from durable evidence",
      evidenceReference: "provider-case-simulated-1",
      userId,
      userEmail: `message-reconcile-${token}@example.test`,
    }))
    expect(await withoutTenantScope(() => prisma.message.findMany({
      where: { id: { in: [acceptedId, simulatedId] }, tenantId },
      orderBy: { id: "asc" },
      select: {
        id: true,
        status: true,
        dispatchProviderMessageId: true,
        dispatchProviderAcceptedAt: true,
      },
    }))).toEqual([
      {
        id: acceptedId,
        status: "SENT",
        dispatchProviderMessageId: `provider_${acceptedId}`,
        dispatchProviderAcceptedAt: acceptedAt,
      },
      {
        id: simulatedId,
        status: "SIMULATED",
        dispatchProviderMessageId: null,
        dispatchProviderAcceptedAt: null,
      },
    ])
    expect(await withoutTenantScope(() => prisma.notificationLog.findMany({
      where: { tenantId, messageId: { in: [acceptedId, simulatedId] } },
      orderBy: { messageId: "asc" },
      select: { messageId: true, status: true, error: true },
    }))).toEqual([
      { messageId: acceptedId, status: "sent", error: null },
      { messageId: simulatedId, status: "simulated", error: null },
    ])
  })
})
