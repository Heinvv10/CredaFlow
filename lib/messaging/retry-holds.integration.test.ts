/**
 * Real-Postgres proof that the messaging retry sweep (processRetryBatch) does
 * not re-send a queued message to a client who has since died or gone under
 * debt review (lib/collections/client-holds.ts): the row is SUPPRESSED, not left
 * retrying, and no dispatch is claimed. A clean client's row is not suppressed
 * by the hold.
 *
 *   RUN_DB_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/messaging/retry-holds.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createChargesTenant, type ChargesTenant } from "@/lib/loan/charges.integration-fixture"
import { createSecondProduct, seedHoldLoan, type HoldCase } from "@/lib/collections/dunning-holds.integration-fixture"
import { prisma } from "@/lib/prisma"
import { processRetryBatch } from "@/lib/messaging/retry"

const suite = process.env.RUN_DB_IT === "1" ? describe : describe.skip
const db = new PrismaClient()
let tenant: ChargesTenant
let templateId = ""
const messages: Record<string, string> = {}

async function queueMessage(contactId: string): Promise<string> {
  const conversation = await db.conversation.create({ data: { tenantId: tenant.tenantId, contactId, channel: "SMS" } })
  const message = await db.message.create({
    data: {
      tenantId: tenant.tenantId, conversationId: conversation.id, channel: "SMS", direction: "OUTBOUND", provider: "BULKSMS",
      status: "RETRYING", retryCount: 1, nextRetryAt: new Date("2000-01-01T00:00:00Z"), templateId,
      lawfulBasis: "SERVICE_COMMS_NCA", bodyText: "Synthetic reminder", toValue: "+27820000000",
    },
  })
  return message.id
}

suite.sequential("retry sweep and client holds (real Postgres)", () => {
  beforeAll(async () => {
    tenant = await createChargesTenant(db, false)
    const second = await createSecondProduct(db, tenant.tenantId)
    templateId = (await db.messageTemplate.create({
      data: { tenantId: tenant.tenantId, event: "retry_hold_it", key: `retry_hold_${randomUUID()}`, channel: "SMS", body: "x", category: "SERVICE" },
    })).id
    const cases: HoldCase[] = [
      { name: "deceased", deceased: true, held: true },
      { name: "debt review on the client's other loan", debtReviewOnSibling: true, held: true },
      { name: "clean", held: false },
    ]
    for (const c of cases) {
      const seeded = await seedHoldLoan(db, tenant, second, c)
      const contact = await db.contact.findFirstOrThrow({ where: { tenantId: tenant.tenantId, clientId: seeded.clientId } })
      messages[c.name] = await queueMessage(contact.id)
    }
    const lead = await db.contact.create({ data: { tenantId: tenant.tenantId, firstSeenChannel: "SMS", status: "LEAD" } })
    messages.lead = await queueMessage(lead.id)
    await processRetryBatch({ limit: 500, now: new Date() })
  })
  afterAll(async () => { await db.$disconnect(); await prisma.$disconnect() })

  const row = (name: string) => db.message.findUniqueOrThrow({ where: { id: messages[name] } })

  it.each(["deceased", "debt review on the client's other loan"])("suppresses a queued message to a client who is %s, and claims no dispatch", async (name) => {
    expect(await row(name)).toMatchObject({
      status: "SUPPRESSED_BY_CONSENT", errorClass: "CONSENT_REVOKED", dispatchToken: null,
      errorMessage: expect.stringContaining("client hold"),
    })
    expect(await db.auditLog.count({ where: { entityId: messages[name], action: "MESSAGE_SUPPRESSED_BY_CONSENT" } })).toBe(1)
    expect(await db.auditLog.count({ where: { entityId: messages[name], action: "MESSAGE_RETRY_DISPATCH_CLAIMED" } })).toBe(0)
  })

  it("does not suppress a clean client's message, or a lead's, for a hold", async () => {
    for (const name of ["clean", "lead"]) {
      const r = await row(name)
      expect(r.errorMessage ?? "", name).not.toContain("client hold")
      expect(r.status, name).not.toBe("SUPPRESSED_BY_CONSENT")
    }
  })
})
