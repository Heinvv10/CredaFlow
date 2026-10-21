/**
 * Real transaction proof that retry-state transitions and their linked
 * NotificationLog projections cannot diverge.
 *
 * Run only against a throwaway, fully migrated PostgreSQL database:
 *
 *   RUN_RETRY_NOTIFICATION_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/messaging/retry-notification-projection.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { describe, expect, it } from "vitest"
import { prisma } from "@/lib/prisma"
import { processRetryBatch } from "./retry"

const RUN = process.env.RUN_RETRY_NOTIFICATION_IT === "1"
const suite = RUN ? describe : describe.skip
const token = randomUUID().replaceAll("-", "")

suite("retry notification projections", () => {
  it("atomically projects expiry, consent suppression, and pre-dispatch failure", async () => {
    const now = new Date("2026-07-23T00:00:00.000Z")
    const tenantId = `tenant_retry_projection_${token}`
    const contactId = `contact_retry_projection_${token}`
    // One thread per contact: Conversation_one_open_per_contact is a partial
    // UNIQUE on (tenantId, contactId) WHERE closedAt IS NULL. The SMS and EMAIL
    // messages share it — per-Message channel may differ from the thread's.
    const conversationId = `conversation_retry_projection_${token}`
    const templateId = `template_retry_projection_${token}`
    const messages = {
      expired: `message_retry_expired_${token}`,
      consent: `message_retry_consent_${token}`,
      email: `message_retry_email_${token}`,
    } as const

    await prisma.tenant.create({
      data: { id: tenantId, slug: `retry-projection-${token}`, name: "Retry projection test" },
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
        event: `retry_projection_${token}`,
        key: `retry_projection_${token}`,
        channel: "SMS",
        body: "Retry projection test",
        category: "SERVICE",
      },
    })
    await prisma.contactConsent.create({
      data: {
        tenantId,
        contactId,
        channel: "SMS",
        purpose: "SERVICE_COMMS",
        status: "REVOKED",
        source: "MANUAL",
        revokedReason: "Synthetic projection regression",
      },
    })
    await prisma.message.createMany({
      data: [
        {
          id: messages.expired,
          tenantId,
          conversationId,
          channel: "SMS",
          direction: "OUTBOUND",
          provider: "BULKSMS",
          status: "RETRYING",
          retryCount: 1,
          nextRetryAt: new Date("2026-07-21T22:00:00.000Z"),
          templateId,
          lawfulBasis: "SERVICE_COMMS_NCA",
          bodyText: "Expired retry",
          toValue: "+27820000000",
          createdAt: new Date("2026-07-21T22:00:00.000Z"),
        },
        {
          id: messages.consent,
          tenantId,
          conversationId,
          channel: "SMS",
          direction: "OUTBOUND",
          provider: "BULKSMS",
          status: "RETRYING",
          retryCount: 1,
          nextRetryAt: new Date("2026-07-22T23:59:00.000Z"),
          templateId,
          lawfulBasis: "SERVICE_COMMS_NCA",
          bodyText: "Consent retry",
          toValue: "+27820000000",
          createdAt: new Date("2026-07-22T22:00:00.000Z"),
        },
        {
          id: messages.email,
          tenantId,
          conversationId,
          channel: "EMAIL",
          direction: "OUTBOUND",
          provider: "SMTP",
          status: "RETRYING",
          retryCount: 1,
          nextRetryAt: new Date("2026-07-22T23:59:00.000Z"),
          lawfulBasis: "SERVICE_COMMS_NCA",
          bodyText: "Email retry",
          toValue: `retry-${token}@example.invalid`,
          payloadFingerprint: "a".repeat(64),
          createdAt: new Date("2026-07-22T22:00:00.000Z"),
        },
      ],
    })
    await prisma.notificationLog.createMany({
      data: Object.entries(messages).map(([kind, messageId]) => ({
        id: `notification_retry_${kind}_${token}`,
        tenantId,
        event: `retry_${kind}`,
        channel: kind === "email" ? "email" : "sms",
        status: "pending",
        messageId,
      })),
    })

    const result = await processRetryBatch({ limit: 10, now })

    expect(result).toMatchObject({
      expired: 1,
      scanned: 2,
      suppressed: 1,
      failedPermanent: 1,
      dispatched: 0,
      simulated: 0,
      manualReconciliation: 0,
      rescheduled: 0,
    })
    expect(await prisma.message.findMany({
      where: { tenantId, id: { in: Object.values(messages) } },
      orderBy: { id: "asc" },
      select: { id: true, status: true, errorClass: true },
    })).toEqual([
      { id: messages.consent, status: "SUPPRESSED_BY_CONSENT", errorClass: "CONSENT_REVOKED" },
      { id: messages.email, status: "FAILED_PERMANENT", errorClass: "EMAIL_PAYLOAD_NOT_RECONSTRUCTABLE" },
      { id: messages.expired, status: "EXPIRED", errorClass: "EXPIRED" },
    ])
    expect(await prisma.notificationLog.findMany({
      where: { tenantId, messageId: { in: Object.values(messages) } },
      orderBy: { messageId: "asc" },
      select: { messageId: true, status: true, error: true },
    })).toEqual([
      {
        messageId: messages.consent,
        status: "suppressed_by_consent",
        error: "canSendTx rejected on retry: CHANNEL_OPTED_OUT",
      },
      {
        messageId: messages.email,
        status: "failed",
        error: expect.stringMatching(/attachments and headers are not durably reconstructable/i),
      },
      {
        messageId: messages.expired,
        status: "expired",
        error: "Message retry window expired",
      },
    ])
  })
})
