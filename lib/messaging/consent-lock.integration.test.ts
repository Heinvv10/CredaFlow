/**
 * Proves that insertion of the first revocation cannot pass an in-flight
 * eligibility decision merely because no ContactConsent row existed to lock.
 * Run only against a throwaway fully migrated PostgreSQL database:
 *
 *   RUN_CONSENT_LOCK_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/messaging/consent-lock.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { describe, expect, it } from "vitest"
import { prisma } from "@/lib/prisma"
import { withoutTenantScope } from "@/lib/tenant-scope"
import { lockContactConsentSubject } from "./consent-lock"

const RUN = process.env.RUN_CONSENT_LOCK_IT === "1"
const suite = RUN ? describe : describe.skip

suite("contact consent subject lock", () => {
  it("blocks the first REVOKED insert until the eligibility holder commits", async () => {
    const token = randomUUID().replaceAll("-", "")
    const tenantId = `tenant_consent_lock_${token}`
    const contactId = `contact_consent_lock_${token}`

    await withoutTenantScope(async () => {
      await prisma.tenant.create({
        data: { id: tenantId, slug: `consent-lock-${token}`, name: "Consent lock test" },
      })
      await prisma.contact.create({
        data: { id: contactId, tenantId, firstSeenChannel: "WHATSAPP" },
      })
    })

    let signalLocked!: () => void
    let releaseEligibility!: () => void
    const locked = new Promise<void>((resolve) => { signalLocked = resolve })
    const release = new Promise<void>((resolve) => { releaseEligibility = resolve })
    let writerAcquired = false

    const eligibility = withoutTenantScope(() => prisma.$transaction(async (tx) => {
      await lockContactConsentSubject(tx, { tenantId, contactId })
      signalLocked()
      await release
    }))

    await locked
    const writer = withoutTenantScope(() => prisma.$transaction(async (tx) => {
      await lockContactConsentSubject(tx, { tenantId, contactId })
      writerAcquired = true
      await tx.contactConsent.create({
        data: {
          tenantId,
          contactId,
          channel: "WHATSAPP",
          purpose: "SERVICE_COMMS",
          status: "REVOKED",
          source: "WA_REPLY_KEYWORD",
        },
      })
    }))

    try {
      await new Promise((resolve) => setTimeout(resolve, 150))
      expect(writerAcquired).toBe(false)
      expect(await withoutTenantScope(() => prisma.contactConsent.count({
        where: { tenantId, contactId },
      }))).toBe(0)
    } finally {
      releaseEligibility()
    }

    await Promise.all([eligibility, writer])
    expect(writerAcquired).toBe(true)
    expect(await withoutTenantScope(() => prisma.contactConsent.count({
      where: {
        tenantId,
        contactId,
        status: "REVOKED",
        effectiveTo: null,
      },
    }))).toBe(1)
  }, 10_000)
})
