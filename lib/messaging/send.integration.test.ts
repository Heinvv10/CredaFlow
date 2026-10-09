/**
 * Integration tests for sendMessage against a throwaway, fully migrated
 * PostgreSQL database:
 *
 *   RUN_MESSAGE_SEND_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/messaging/send.integration.test.ts
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest"
import { randomUUID } from "node:crypto"
import { prisma } from "@/lib/prisma"
import { withoutTenantScope } from "@/lib/tenant-scope"
import { MessageIdempotencyConflictError, sendMessage, SendBlockedError } from "./send"
import { dispatch } from "./providers"

vi.mock("./providers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./providers")>()),
  dispatch: vi.fn(),
}))

// Fixture identifiers
const FIXTURE_TOKEN = randomUUID().replaceAll("-", "")
const TENANT_ID = `test-tenant-phase9-s2-${FIXTURE_TOKEN}`
const CONTACT_ID = `test-contact-phase9-s2-${FIXTURE_TOKEN}`
const TEMPLATE_ID = `test-template-phase9-s2-${FIXTURE_TOKEN}`
const providerAcceptedAt = new Date("2026-07-19T10:00:00.000Z")

const RUN = process.env.RUN_MESSAGE_SEND_IT === "1"
const suite = RUN ? describe : describe.skip

suite("sendMessage integration", () => {
  beforeAll(() => withoutTenantScope(async () => {
    await prisma.tenant.upsert({
      where: { id: TENANT_ID },
      update: {},
      create: {
        id: TENANT_ID,
        slug: TENANT_ID,
        name: "Phase 9 S2 test",
      },
    })
    await prisma.contact.upsert({
      where: { id: CONTACT_ID },
      update: { blockedAt: null, status: "CLIENT" },
      create: {
        id: CONTACT_ID, tenantId: TENANT_ID, status: "CLIENT",
        firstSeenChannel: "MANUAL", firstSeenContext: "integration-test",
      },
    })
    await prisma.emailConfig.upsert({
      where: { tenantId: TENANT_ID },
      update: { active: true, provider: "IMAP_SMTP" },
      create: {
        tenantId: TENANT_ID,
        provider: "IMAP_SMTP",
        fromName: "Integration Test Lender",
        fromAddress: "noreply@example.test",
        smtpHost: "smtp.example.test",
        smtpUser: "noreply@example.test",
        smtpPass: "synthetic-secret",
        active: true,
      },
    })
    await prisma.messageTemplate.upsert({
      where: { id: TEMPLATE_ID },
      update: {},
      create: {
        id: TEMPLATE_ID, tenantId: TENANT_ID,
        event: `test_service_${FIXTURE_TOKEN}`, key: `test_service_${FIXTURE_TOKEN}`,
        channel: "EMAIL", category: "SERVICE", statutoryOverride: false,
        subject: "Hello {{name}}", body: "Hi {{name}}", active: true,
      },
    })
  }))

  beforeEach(() => withoutTenantScope(async () => {
    await prisma.message.deleteMany({ where: { tenantId: TENANT_ID } })
    await prisma.conversation.deleteMany({ where: { tenantId: TENANT_ID } })
    await prisma.contactConsent.deleteMany({ where: { tenantId: TENANT_ID } })
    vi.clearAllMocks()
  }))

  it("happy-path: SERVICE template → SENT + MESSAGE_SENT audit", () => withoutTenantScope(async () => {
    vi.mocked(dispatch).mockResolvedValue({ providerMessageId: "prov-1", acceptedAt: providerAcceptedAt })
    const template = await prisma.messageTemplate.findUniqueOrThrow({ where: { id: TEMPLATE_ID } })

    const msg = await sendMessage({
      contactId: CONTACT_ID, channel: "EMAIL", template,
      vars: { name: "Sipho" }, toValue: "test@example.com",
    })

    const reloaded = await prisma.message.findUniqueOrThrow({ where: { id: msg.id } })
    expect(reloaded.status).toBe("SENT")
    expect(reloaded.providerMessageId).toBe("prov-1")
    expect(reloaded.lawfulBasis).toBe("SERVICE_COMMS_NCA")

    const audit = await prisma.auditLog.findFirst({
      where: { entity: "Message", entityId: msg.id, action: "MESSAGE_SENT" },
    })
    expect(audit).not.toBeNull()
  }))

  it("blocked MARKETING (no consent) → SendBlockedError, no Message", () => withoutTenantScope(async () => {
    vi.mocked(dispatch).mockResolvedValue({ providerMessageId: "prov-2", acceptedAt: providerAcceptedAt })
    const marketingTemplate = await prisma.messageTemplate.create({
      data: {
        tenantId: TENANT_ID, event: `test_market_${FIXTURE_TOKEN}`, key: `test_market_${FIXTURE_TOKEN}`,
        channel: "EMAIL", category: "MARKETING", purposeRequired: "CROSS_SELL_CREDIT",
        statutoryOverride: false, subject: "Promo", body: "Hi {{name}}", active: true,
      },
    })

    await expect(sendMessage({
      contactId: CONTACT_ID, channel: "EMAIL", template: marketingTemplate,
      vars: { name: "X" }, toValue: "x@y.com",
    })).rejects.toBeInstanceOf(SendBlockedError)

    const count = await prisma.message.count({ where: { templateId: marketingTemplate.id } })
    expect(count).toBe(0)

    await prisma.messageTemplate.delete({ where: { id: marketingTemplate.id } })
  }))

  it("idempotency: same (provider, providerMessageId) is rejected by the unique constraint", () => withoutTenantScope(async () => {
    vi.mocked(dispatch).mockResolvedValue({ providerMessageId: "prov-dup", acceptedAt: providerAcceptedAt })
    const template = await prisma.messageTemplate.findUniqueOrThrow({ where: { id: TEMPLATE_ID } })

    await sendMessage({
      contactId: CONTACT_ID, channel: "EMAIL", template,
      vars: { name: "Sipho" }, toValue: "x@y.com",
    })
    await expect(prisma.message.create({
      data: {
        tenantId: TENANT_ID, conversationId: (await prisma.conversation.findFirstOrThrow({
          where: { tenantId: TENANT_ID },
        })).id,
        channel: "EMAIL", direction: "OUTBOUND",
        provider: "SMTP", providerMessageId: "prov-dup",
        status: "SENT", templateId: TEMPLATE_ID,
        bodyText: "x", toValue: "x@y.com",
      },
    })).rejects.toThrow()
  }))

  it("idempotency: the same business key rejects changed attachment bytes", () => withoutTenantScope(async () => {
    vi.mocked(dispatch).mockResolvedValue({ providerMessageId: "prov-payload", acceptedAt: providerAcceptedAt })
    const template = await prisma.messageTemplate.findUniqueOrThrow({ where: { id: TEMPLATE_ID } })
    const idempotencyKey = "integration:exact-email-payload"

    await sendMessage({
      contactId: CONTACT_ID,
      channel: "EMAIL",
      template,
      vars: { name: "Sipho" },
      toValue: "x@y.com",
      idempotencyKey,
      replyTo: "support@example.test",
      attachments: [{
        filename: "evidence.pdf",
        contentType: "application/pdf",
        content: Buffer.from("first-pdf"),
      }],
    })

    await expect(sendMessage({
      contactId: CONTACT_ID,
      channel: "EMAIL",
      template,
      vars: { name: "Sipho" },
      toValue: "x@y.com",
      idempotencyKey,
      replyTo: "support@example.test",
      attachments: [{
        filename: "evidence.pdf",
        contentType: "application/pdf",
        content: Buffer.from("different-pdf"),
      }],
    })).rejects.toBeInstanceOf(MessageIdempotencyConflictError)

    expect(dispatch).toHaveBeenCalledOnce()
    expect(await prisma.message.findFirst({
      where: { tenantId: TENANT_ID, idempotencyKey },
      select: { payloadFingerprint: true },
    })).toEqual({ payloadFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) })
  }))

  it("consent race: revoke after canSendTx but before commit → SendBlockedError", () => withoutTenantScope(async () => {
    const template = await prisma.messageTemplate.create({
      data: {
        tenantId: TENANT_ID, event: `test_race_${FIXTURE_TOKEN}`, key: `test_race_${FIXTURE_TOKEN}`,
        channel: "EMAIL", category: "MARKETING", purposeRequired: "CROSS_SELL_CREDIT",
        statutoryOverride: false, subject: "S", body: "Hi {{name}}", active: true,
      },
    })

    // Grant consent first, then race a revoke
    await prisma.contactConsent.create({
      data: {
        tenantId: TENANT_ID, contactId: CONTACT_ID,
        channel: "EMAIL", purpose: "CROSS_SELL_CREDIT",
        status: "GRANTED", source: "MANUAL",
        effectiveFrom: new Date(),
      },
    })

    // Revoke before the send opens its tx — the current schema retains the
    // latest decision in the unique contact/channel/purpose row.
    await prisma.contactConsent.updateMany({
      where: {
        tenantId: TENANT_ID,
        contactId: CONTACT_ID,
        channel: "EMAIL",
        purpose: "CROSS_SELL_CREDIT",
      },
      data: {
        status: "REVOKED",
        source: "PORTAL_TOGGLE",
        effectiveFrom: new Date(),
        effectiveTo: null,
      },
    })

    vi.mocked(dispatch).mockResolvedValue({ providerMessageId: "prov-race", acceptedAt: providerAcceptedAt })
    await expect(sendMessage({
      contactId: CONTACT_ID, channel: "EMAIL", template,
      vars: { name: "X" }, toValue: "x@y.com",
    })).rejects.toBeInstanceOf(SendBlockedError)

    await prisma.messageTemplate.delete({ where: { id: template.id } })
  }))
})
