/**
 * Proves the retry no-replay claim commits independently of the sweep
 * transaction. Run only against a throwaway fully migrated PostgreSQL DB:
 *
 *   RUN_RETRY_CLAIM_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/messaging/retry-claim.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { describe, expect, it } from "vitest"
import { prisma } from "@/lib/prisma"
import {
  claimRetryDispatch,
} from "./retry"
import { withoutTenantScope } from "@/lib/tenant-scope"

const RUN = process.env.RUN_RETRY_CLAIM_IT === "1"
const suite = RUN ? describe : describe.skip
const token = randomUUID().replaceAll("-", "")

suite("retry dispatch durable claim", () => {
  it("gives every delayed batch row a fresh durable lease that survives an outer sweep rollback", async () => {
    const tenantId = `tenant_retry_claim_${token}`
    const contactId = `contact_retry_claim_${token}`
    const conversationId = `conversation_retry_claim_${token}`
    const templateId = `template_retry_claim_${token}`
    const messageIds = [
      `message_retry_claim_first_${token}`,
      `message_retry_claim_delayed_${token}`,
    ]
    const eligibleAt = new Date("2000-01-01T12:00:00.000Z")

    await prisma.tenant.create({
      data: { id: tenantId, slug: `retry-claim-${token}`, name: "Retry claim test" },
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
        event: `retry_claim_${token}`,
        key: `retry_claim_${token}`,
        channel: "SMS",
        body: "Retry claim test",
        category: "SERVICE",
      },
    })
    await prisma.message.createMany({
      data: messageIds.map((id) => ({
        id,
        tenantId,
        conversationId,
        channel: "SMS",
        direction: "OUTBOUND",
        provider: "BULKSMS",
        status: "RETRYING",
        retryCount: 1,
        nextRetryAt: new Date("2000-01-01T11:59:00.000Z"),
        templateId,
        lawfulBasis: "SERVICE_COMMS_NCA",
        bodyText: "Retry claim test",
        toValue: "+27820000000",
      })),
    })

    const claimedAfter: number[] = []
    await expect(withoutTenantScope(() => prisma.$transaction(async (outerTx) => {
      // Match the sweep's pre-claim read without taking a Message row lock.
      await outerTx.message.findMany({ where: { id: { in: messageIds }, tenantId } })
      for (const [index, id] of messageIds.entries()) {
        if (index > 0) {
          // Model a later row in a slow sweep. Its lease must start here, not
          // from the timestamp captured when the batch was selected.
          await new Promise((resolve) => setTimeout(resolve, 30))
        }
        claimedAfter[index] = Date.now()
        expect(await claimRetryDispatch({
          id,
          tenantId,
          retryCount: 1,
          provider: "BULKSMS",
          eligibleAt,
        })).toEqual(expect.any(String))
      }

      // Simulate the sweep transaction failing after provider acceptance.
      throw new Error("simulated outer sweep rollback")
    }))).rejects.toThrow("simulated outer sweep rollback")

    const persisted = await prisma.message.findMany({
      where: { id: { in: messageIds }, tenantId },
      orderBy: { id: "asc" },
      select: {
        id: true,
        status: true,
        errorClass: true,
        nextRetryAt: true,
        dispatchState: true,
        dispatchToken: true,
        dispatchAttempt: true,
        dispatchStartedAt: true,
        dispatchLeaseExpiresAt: true,
      },
    })
    expect(persisted).toHaveLength(2)
    for (const row of persisted) {
      expect(row).toEqual(expect.objectContaining({
        status: "QUEUED",
        errorClass: null,
        nextRetryAt: null,
        dispatchState: "DISPATCHING",
        dispatchToken: expect.any(String),
        dispatchAttempt: 2,
      }))
      expect(row.dispatchStartedAt).toBeInstanceOf(Date)
      expect(row.dispatchLeaseExpiresAt).toBeInstanceOf(Date)
      const sourceIndex = messageIds.indexOf(row.id)
      expect(sourceIndex).toBeGreaterThanOrEqual(0)
      expect(row.dispatchStartedAt!.getTime()).toBeGreaterThanOrEqual(claimedAfter[sourceIndex])
      expect(row.dispatchStartedAt!.getTime()).toBeGreaterThan(eligibleAt.getTime())
      expect(row.dispatchLeaseExpiresAt!.getTime()).toBeGreaterThan(Date.now())
    }
    const first = persisted.find((row) => row.id === messageIds[0])!
    const delayed = persisted.find((row) => row.id === messageIds[1])!
    expect(delayed.dispatchStartedAt!.getTime()).toBeGreaterThan(first.dispatchStartedAt!.getTime())
    expect(await prisma.message.count({
      where: { id: { in: messageIds }, tenantId, status: "RETRYING" },
    })).toBe(0)
    expect(await prisma.auditLog.count({
      where: {
        tenantId,
        entity: "Message",
        entityId: { in: messageIds },
        action: "MESSAGE_RETRY_DISPATCH_CLAIMED",
      },
    })).toBe(2)
  })
})
