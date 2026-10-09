/**
 * Real PostgreSQL proofs for business-event reservation and dispatch CAS.
 * Run only against a throwaway fully migrated database:
 *
 *   RUN_MESSAGE_DISPATCH_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/messaging/dispatch-control.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { describe, expect, it, vi } from "vitest"

const { dispatchMock } = vi.hoisted(() => ({ dispatchMock: vi.fn() }))

vi.mock("./providers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./providers")>()),
  dispatch: dispatchMock,
}))

import { prisma } from "@/lib/prisma"
import { withoutTenantScope } from "@/lib/tenant-scope"
import {
  completeMessageDispatch,
  holdMessageDispatchForReconciliation,
  MessageDispatchConflictError,
} from "./dispatch-control"
import { reconcileHeldMessage } from "./reconcile-held-message"
import { MessageIdempotencyConflictError, sendMessage } from "./send"

const RUN = process.env.RUN_MESSAGE_DISPATCH_IT === "1"
const suite = RUN ? describe : describe.skip

async function createFixture(label: string) {
  const token = randomUUID().replaceAll("-", "")
  const tenantId = `tenant_dispatch_${label}_${token}`
  const contactId = `contact_dispatch_${label}_${token}`
  const userId = `user_dispatch_${label}_${token}`
  const templateId = `template_dispatch_${label}_${token}`
  const conversationId = `conversation_dispatch_${label}_${token}`

  await withoutTenantScope(async () => {
    await prisma.tenant.create({
      data: { id: tenantId, slug: `dispatch-${label}-${token}`, name: "Message dispatch test" },
    })
    await prisma.user.create({
      data: {
        id: userId,
        tenantId,
        email: `dispatch-${label}-${token}@example.test`,
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
        event: `dispatch_${label}_${token}`,
        key: `dispatch_${label}_${token}`,
        channel: "SMS",
        body: "Synthetic dispatch {{body}}",
        category: "SERVICE",
      },
    })
  })

  const template = await withoutTenantScope(() => prisma.messageTemplate.findFirstOrThrow({
    where: { id: templateId, tenantId },
  }))
  return { token, tenantId, contactId, userId, templateId, conversationId, template }
}

suite("durable message dispatch control", () => {
  it("dispatches once when two callers reserve the same business event", async () => {
    const fixture = await createFixture("idempotency")
    let signalProviderStarted!: () => void
    let releaseProvider!: () => void
    const providerStarted = new Promise<void>((resolve) => { signalProviderStarted = resolve })
    const providerRelease = new Promise<void>((resolve) => { releaseProvider = resolve })
    dispatchMock.mockImplementationOnce(async () => {
      signalProviderStarted()
      await providerRelease
      return { providerMessageId: `provider_${fixture.token}`, acceptedAt: new Date() }
    })

    const args = {
      contactId: fixture.contactId,
      channel: "SMS" as const,
      template: fixture.template,
      vars: { body: "once" },
      toValue: "+27820000000",
      conversationId: fixture.conversationId,
      idempotencyKey: `integration:${fixture.token}`,
    }
    const first = withoutTenantScope(() => sendMessage(args))
    await providerStarted

    const duplicate = await withoutTenantScope(() => sendMessage(args))
    expect(duplicate.status).toBe("QUEUED")
    expect(dispatchMock).toHaveBeenCalledTimes(1)

    releaseProvider()
    const completed = await first
    expect(completed.status).toBe("SENT")
    expect(await withoutTenantScope(() => prisma.conversation.findFirst({
      where: { id: fixture.conversationId, tenantId: fixture.tenantId },
      select: { lastOutboundAt: true },
    }))).toEqual({ lastOutboundAt: completed.sentAt })
    expect(await withoutTenantScope(() => prisma.message.count({
      where: { tenantId: fixture.tenantId, idempotencyKey: args.idempotencyKey },
    }))).toBe(1)
  }, 15_000)

  it("rejects an idempotency-key replay whose rendered payload changed", async () => {
    const fixture = await createFixture("payload_conflict")
    dispatchMock.mockClear()
    dispatchMock.mockResolvedValue({ providerMessageId: `provider_${fixture.token}`, acceptedAt: new Date() })
    const idempotencyKey = `integration:payload:${fixture.token}`

    await withoutTenantScope(() => sendMessage({
      contactId: fixture.contactId,
      channel: "SMS",
      template: fixture.template,
      vars: { body: "FIRST BODY" },
      toValue: "+27820000000",
      conversationId: fixture.conversationId,
      idempotencyKey,
    }))

    await expect(withoutTenantScope(() => sendMessage({
      contactId: fixture.contactId,
      channel: "SMS",
      template: fixture.template,
      vars: { body: "DIFFERENT BODY" },
      toValue: "+27820000000",
      conversationId: fixture.conversationId,
      idempotencyKey,
    }))).rejects.toBeInstanceOf(MessageIdempotencyConflictError)

    expect(dispatchMock).toHaveBeenCalledTimes(1)
    expect(await withoutTenantScope(() => prisma.message.findFirst({
      where: { tenantId: fixture.tenantId, idempotencyKey },
      select: { bodyText: true, toValue: true },
    }))).toEqual({
      bodyText: "Synthetic dispatch FIRST BODY",
      toValue: "+27820000000",
    })
  })

  it("preserves durable provider evidence and its audit on a reconciliation hold", async () => {
    const fixture = await createFixture("evidence")
    const messageId = `message_evidence_${fixture.token}`
    const dispatchToken = randomUUID()
    const acceptedAt = new Date("2026-07-22T12:00:00.000Z")
    await withoutTenantScope(() => prisma.message.create({
      data: {
        id: messageId,
        tenantId: fixture.tenantId,
        conversationId: fixture.conversationId,
        channel: "SMS",
        direction: "OUTBOUND",
        provider: "BULKSMS",
        status: "QUEUED",
        templateId: fixture.templateId,
        bodyText: "Synthetic accepted dispatch",
        dispatchToken,
        dispatchState: "DISPATCHING",
        dispatchAttempt: 1,
        dispatchStartedAt: new Date(),
        dispatchLeaseExpiresAt: new Date(Date.now() + 60_000),
      },
    }))

    await withoutTenantScope(() => holdMessageDispatchForReconciliation({
      tenantId: fixture.tenantId,
      messageId,
      dispatchToken,
      state: "ACCEPTED",
      reason: new Error("terminal transaction unavailable"),
      providerMessageId: `provider_evidence_${fixture.token}`,
      providerAcceptedAt: acceptedAt,
      action: "MESSAGE_SENT_DB_WRITE_FAILED",
    }))

    expect(await withoutTenantScope(() => prisma.message.findFirst({
      where: { id: messageId, tenantId: fixture.tenantId },
      select: {
        status: true,
        dispatchState: true,
        dispatchProviderMessageId: true,
        dispatchProviderAcceptedAt: true,
        dispatchLeaseExpiresAt: true,
      },
    }))).toEqual({
      status: "QUEUED",
      dispatchState: "ACCEPTED",
      dispatchProviderMessageId: `provider_evidence_${fixture.token}`,
      dispatchProviderAcceptedAt: acceptedAt,
      dispatchLeaseExpiresAt: null,
    })
    expect(await withoutTenantScope(() => prisma.auditLog.count({
      where: {
        tenantId: fixture.tenantId,
        entityId: messageId,
        action: "MESSAGE_SENT_DB_WRITE_FAILED",
      },
    }))).toBe(1)
  })

  it("records a simulation completion without provider-acceptance evidence", async () => {
    const fixture = await createFixture("simulation_evidence")
    const messageId = `message_simulation_evidence_${fixture.token}`
    const dispatchToken = randomUUID()
    await withoutTenantScope(() => prisma.message.create({
      data: {
        id: messageId,
        tenantId: fixture.tenantId,
        conversationId: fixture.conversationId,
        channel: "SMS",
        direction: "OUTBOUND",
        provider: "BULKSMS",
        status: "QUEUED",
        templateId: fixture.templateId,
        bodyText: "Synthetic local simulation",
        dispatchToken,
        dispatchState: "DISPATCHING",
        dispatchAttempt: 1,
        dispatchStartedAt: new Date(),
        dispatchLeaseExpiresAt: new Date(Date.now() + 60_000),
      },
    }))

    await withoutTenantScope(() => completeMessageDispatch({
      tenantId: fixture.tenantId,
      messageId,
      dispatchToken,
      simulationReceiptId: `dry-run-${fixture.token}`,
      simulated: true,
    }))

    expect(await withoutTenantScope(() => prisma.message.findFirst({
      where: { id: messageId, tenantId: fixture.tenantId },
      select: {
        status: true,
        sentAt: true,
        dispatchState: true,
        dispatchCompletedAt: true,
        dispatchProviderAcceptedAt: true,
        dispatchProviderMessageId: true,
        simulationReceiptId: true,
      },
    }))).toEqual({
      status: "SIMULATED",
      sentAt: null,
      dispatchState: "SIMULATED",
      dispatchCompletedAt: expect.any(Date),
      dispatchProviderAcceptedAt: null,
      dispatchProviderMessageId: null,
      simulationReceiptId: `dry-run-${fixture.token}`,
    })
    const audit = await withoutTenantScope(() => prisma.auditLog.findFirstOrThrow({
      where: { tenantId: fixture.tenantId, entityId: messageId, action: "MESSAGE_SIMULATED" },
      select: { newValue: true },
    }))
    expect(audit.newValue).toEqual(expect.objectContaining({
      simulated: true,
      providerAcceptedAt: null,
      providerMessageId: null,
      simulationReceiptId: `dry-run-${fixture.token}`,
      simulationCompletedAt: expect.any(String),
    }))

    await expect(withoutTenantScope(() => completeMessageDispatch({
      tenantId: fixture.tenantId,
      messageId,
      dispatchToken,
      simulationReceiptId: `dry-run-${fixture.token}`,
      providerMessageId: `fabricated-provider-${fixture.token}`,
      providerAcceptedAt: new Date("2026-07-22T12:00:00.000Z"),
      simulated: true,
    }))).rejects.toThrow(/cannot contain provider acceptance evidence/i)
  })

  it("rolls back the terminal message write when its audit cannot commit", async () => {
    const fixture = await createFixture("audit_rollback")
    const messageId = `message_audit_rollback_${fixture.token}`
    const dispatchToken = randomUUID()
    const acceptedAt = new Date("2026-07-22T12:00:00.000Z")
    await withoutTenantScope(() => prisma.message.create({
      data: {
        id: messageId,
        tenantId: fixture.tenantId,
        conversationId: fixture.conversationId,
        channel: "SMS",
        direction: "OUTBOUND",
        provider: "BULKSMS",
        status: "QUEUED",
        templateId: fixture.templateId,
        bodyText: "Synthetic audited dispatch",
        dispatchToken,
        dispatchState: "DISPATCHING",
        dispatchAttempt: 1,
        dispatchStartedAt: new Date(),
        dispatchLeaseExpiresAt: new Date(Date.now() + 60_000),
      },
    }))

    await expect(withoutTenantScope(() => completeMessageDispatch({
      tenantId: fixture.tenantId,
      messageId,
      dispatchToken,
      providerMessageId: `provider_audit_${fixture.token}`,
      providerAcceptedAt: acceptedAt,
      simulated: false,
      userId: `missing_user_${fixture.token}`,
    }))).rejects.toThrow()

    expect(await withoutTenantScope(() => prisma.message.findFirst({
      where: { id: messageId, tenantId: fixture.tenantId },
      select: { status: true, dispatchState: true, providerMessageId: true },
    }))).toEqual({
      status: "QUEUED",
      dispatchState: "DISPATCHING",
      providerMessageId: null,
    })
  })

  it("does not let a late sender overwrite an audited operator resolution", async () => {
    const fixture = await createFixture("cas")
    const messageId = `message_cas_${fixture.token}`
    const dispatchToken = randomUUID()
    const acceptedAt = new Date("2026-07-22T12:00:00.000Z")
    await withoutTenantScope(() => prisma.message.create({
      data: {
        id: messageId,
        tenantId: fixture.tenantId,
        conversationId: fixture.conversationId,
        channel: "SMS",
        direction: "OUTBOUND",
        provider: "BULKSMS",
        status: "QUEUED",
        templateId: fixture.templateId,
        bodyText: "Synthetic ambiguous dispatch",
        dispatchToken,
        dispatchState: "AMBIGUOUS",
        dispatchAttempt: 1,
        dispatchStartedAt: new Date(),
        dispatchCompletedAt: new Date(),
      },
    }))

    await withoutTenantScope(() => reconcileHeldMessage({
      tenantId: fixture.tenantId,
      messageId,
      outcome: "NOT_SENT",
      reason: "Provider case confirms the request was rejected before acceptance",
      evidenceReference: `provider-case-${fixture.token}`,
      userId: fixture.userId,
      userEmail: `dispatch-cas-${fixture.token}@example.test`,
    }))

    await expect(withoutTenantScope(() => completeMessageDispatch({
      tenantId: fixture.tenantId,
      messageId,
      dispatchToken,
      providerMessageId: `late-provider-${fixture.token}`,
      providerAcceptedAt: acceptedAt,
      simulated: false,
    }))).rejects.toBeInstanceOf(MessageDispatchConflictError)

    expect(await withoutTenantScope(() => prisma.message.findFirst({
      where: { id: messageId, tenantId: fixture.tenantId },
      select: {
        status: true,
        dispatchState: true,
        providerMessageId: true,
        dispatchEvidenceReference: true,
        reconciliationEvidenceReference: true,
      },
    }))).toEqual({
      status: "FAILED_PERMANENT",
      dispatchState: "RECONCILED_NOT_SENT",
      providerMessageId: null,
      dispatchEvidenceReference: null,
      reconciliationEvidenceReference: `provider-case-${fixture.token}`,
    })
  })
})
