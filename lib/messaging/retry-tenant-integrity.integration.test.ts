/**
 * Proves the cross-tenant retry sweep fails closed before any provider claim.
 * Run only against a throwaway fully migrated PostgreSQL DB:
 *
 *   RUN_RETRY_TENANT_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/messaging/retry-tenant-integrity.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { describe, expect, it } from "vitest"
import { prisma } from "@/lib/prisma"
import { processRetryBatch } from "./retry"

const RUN = process.env.RUN_RETRY_TENANT_IT === "1"
const suite = RUN ? describe : describe.skip
const token = randomUUID().replaceAll("-", "")

suite("retry tenant-integrity boundary", () => {
  it("terminally suppresses cross-tenant template, conversation, and contact links before dispatch", async () => {
    const tenantA = `tenant_retry_integrity_a_${token}`
    const tenantB = `tenant_retry_integrity_b_${token}`
    const contactA = `contact_retry_integrity_a_${token}`
    const contactB = `contact_retry_integrity_b_${token}`
    const conversationA = `conversation_retry_integrity_a_${token}`
    const conversationB = `conversation_retry_integrity_b_${token}`
    const conversationAContactB = `conversation_retry_integrity_ab_${token}`
    const templateA = `template_retry_integrity_a_${token}`
    const templateB = `template_retry_integrity_b_${token}`
    const messages = {
      template: `message_retry_integrity_template_${token}`,
      conversation: `message_retry_integrity_conversation_${token}`,
      contact: `message_retry_integrity_contact_${token}`,
    } as const

    await prisma.tenant.createMany({
      data: [
        { id: tenantA, slug: `retry-integrity-a-${token}`, name: "Retry integrity A" },
        { id: tenantB, slug: `retry-integrity-b-${token}`, name: "Retry integrity B" },
      ],
    })
    await prisma.contact.createMany({
      data: [
        { id: contactA, tenantId: tenantA, firstSeenChannel: "SMS" },
        { id: contactB, tenantId: tenantB, firstSeenChannel: "SMS" },
      ],
    })
    await prisma.conversation.createMany({
      data: [
        { id: conversationA, tenantId: tenantA, contactId: contactA, channel: "SMS" },
        { id: conversationB, tenantId: tenantB, contactId: contactB, channel: "SMS" },
        // The schema's FK is global rather than tenant-composite, so this is
        // the historical-corruption shape the runtime guard must contain.
        { id: conversationAContactB, tenantId: tenantA, contactId: contactB, channel: "SMS" },
      ],
    })
    await prisma.messageTemplate.createMany({
      data: [
        {
          id: templateA,
          tenantId: tenantA,
          event: `retry_integrity_a_${token}`,
          key: `retry_integrity_a_${token}`,
          channel: "SMS",
          body: "Retry integrity A",
          category: "SERVICE",
        },
        {
          id: templateB,
          tenantId: tenantB,
          event: `retry_integrity_b_${token}`,
          key: `retry_integrity_b_${token}`,
          channel: "SMS",
          body: "Retry integrity B",
          category: "SERVICE",
        },
      ],
    })

    const nextRetryAt = new Date(Date.now() - 60_000)
    await prisma.message.createMany({
      data: [
        {
          id: messages.template,
          tenantId: tenantA,
          conversationId: conversationA,
          channel: "SMS",
          direction: "OUTBOUND",
          provider: "BULKSMS",
          status: "RETRYING",
          retryCount: 1,
          nextRetryAt,
          templateId: templateB,
          lawfulBasis: "SERVICE_COMMS_NCA",
          bodyText: "Cross-tenant template",
          toValue: "+27820000000",
        },
        {
          id: messages.conversation,
          tenantId: tenantA,
          conversationId: conversationB,
          channel: "SMS",
          direction: "OUTBOUND",
          provider: "BULKSMS",
          status: "RETRYING",
          retryCount: 1,
          nextRetryAt,
          templateId: templateA,
          lawfulBasis: "SERVICE_COMMS_NCA",
          bodyText: "Cross-tenant conversation",
          toValue: "+27820000000",
        },
        {
          id: messages.contact,
          tenantId: tenantA,
          conversationId: conversationAContactB,
          channel: "SMS",
          direction: "OUTBOUND",
          provider: "BULKSMS",
          status: "RETRYING",
          retryCount: 1,
          nextRetryAt,
          templateId: templateA,
          lawfulBasis: "SERVICE_COMMS_NCA",
          bodyText: "Cross-tenant contact",
          toValue: "+27820000000",
        },
      ],
    })

    const result = await processRetryBatch({ limit: 10, now: new Date() })

    expect(result).toMatchObject({
      scanned: 3,
      failedPermanent: 3,
      dispatched: 0,
      simulated: 0,
      manualReconciliation: 0,
      rescheduled: 0,
    })
    const persisted = await prisma.message.findMany({
      where: { tenantId: tenantA, id: { in: Object.values(messages) } },
      orderBy: { id: "asc" },
      select: {
        id: true,
        status: true,
        errorClass: true,
        nextRetryAt: true,
        providerMessageId: true,
        dispatchAttempt: true,
        dispatchState: true,
      },
    })
    expect(persisted).toHaveLength(3)
    for (const message of persisted) {
      expect(message).toMatchObject({
        status: "FAILED_PERMANENT",
        errorClass: "TENANT_INTEGRITY",
        nextRetryAt: null,
        providerMessageId: null,
        dispatchAttempt: 0,
        dispatchState: null,
      })
    }

    const integrityAudits = await prisma.auditLog.findMany({
      where: {
        tenantId: tenantA,
        entity: "Message",
        entityId: { in: Object.values(messages) },
        action: "MESSAGE_RETRY_SUPPRESSED_TENANT_INTEGRITY",
      },
      select: { entityId: true, newValue: true },
    })
    expect(integrityAudits).toHaveLength(3)
    expect(new Set(integrityAudits.map((audit) =>
      (audit.newValue as { invalidRelation?: string }).invalidRelation,
    ))).toEqual(new Set(["template", "conversation", "contact"]))
    expect(await prisma.auditLog.count({
      where: {
        tenantId: tenantA,
        entityId: { in: Object.values(messages) },
        action: "MESSAGE_RETRY_DISPATCH_CLAIMED",
      },
    })).toBe(0)
  })

  it("cannot authorise a tenant-A retry with tenant-B consent corruption", async () => {
    const tenantA = `tenant_retry_consent_a_${token}`
    const tenantB = `tenant_retry_consent_b_${token}`
    const contactA = `contact_retry_consent_a_${token}`
    const conversationA = `conversation_retry_consent_a_${token}`
    const templateA = `template_retry_consent_a_${token}`
    const consentB = `consent_retry_consent_b_${token}`
    const messageA = `message_retry_consent_a_${token}`

    await prisma.tenant.createMany({
      data: [
        { id: tenantA, slug: `retry-consent-a-${token}`, name: "Retry consent A" },
        { id: tenantB, slug: `retry-consent-b-${token}`, name: "Retry consent B" },
      ],
    })
    await prisma.contact.create({
      data: { id: contactA, tenantId: tenantA, firstSeenChannel: "SMS" },
    })
    await prisma.conversation.create({
      data: { id: conversationA, tenantId: tenantA, contactId: contactA, channel: "SMS" },
    })
    await prisma.messageTemplate.create({
      data: {
        id: templateA,
        tenantId: tenantA,
        event: `retry_consent_a_${token}`,
        key: `retry_consent_a_${token}`,
        channel: "SMS",
        body: "Retry consent A",
        category: "MARKETING",
        purposeRequired: "MARKETING_GENERAL",
      },
    })
    // Historical-corruption shape: the FK is global on Contact.id rather than
    // tenant-composite. This foreign consent must never authorise tenant A.
    await prisma.contactConsent.create({
      data: {
        id: consentB,
        tenantId: tenantB,
        contactId: contactA,
        channel: "SMS",
        purpose: "MARKETING_GENERAL",
        status: "GRANTED",
        source: "IMPORT",
      },
    })
    await prisma.message.create({
      data: {
        id: messageA,
        tenantId: tenantA,
        conversationId: conversationA,
        channel: "SMS",
        direction: "OUTBOUND",
        provider: "BULKSMS",
        status: "RETRYING",
        retryCount: 1,
        nextRetryAt: new Date(Date.now() - 60_000),
        templateId: templateA,
        lawfulBasis: "EXPLICIT_OPT_IN",
        bodyText: "Foreign consent must not authorise this",
        toValue: "+27820000000",
      },
    })

    const result = await processRetryBatch({ limit: 10, now: new Date() })

    expect(result).toMatchObject({
      scanned: 1,
      suppressed: 1,
      dispatched: 0,
      simulated: 0,
      manualReconciliation: 0,
      rescheduled: 0,
      failedPermanent: 0,
    })
    expect(await prisma.message.findUniqueOrThrow({
      where: { id: messageA, tenantId: tenantA },
      select: {
        status: true,
        errorClass: true,
        dispatchAttempt: true,
        dispatchState: true,
        providerMessageId: true,
      },
    })).toEqual({
      status: "SUPPRESSED_BY_CONSENT",
      errorClass: "CONSENT_REVOKED",
      dispatchAttempt: 0,
      dispatchState: null,
      providerMessageId: null,
    })
    expect(await prisma.auditLog.count({
      where: {
        tenantId: tenantA,
        entity: "Message",
        entityId: messageA,
        action: "MESSAGE_RETRY_DISPATCH_CLAIMED",
      },
    })).toBe(0)
  })
})
