/** Real PG: repricing and its written notice commit/roll back together;
 * tenant boundaries are foreign-key enforced. Only provider dispatch is fake.
 */
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { prisma } from "@/lib/prisma"
import { withoutTenantScope } from "@/lib/tenant-scope"
import { createRepriceLoan, createRepriceTenant, recordPrime, type RepriceTenant } from "./reprice.integration-fixture"
import { repriceLoanForReference } from "./reprice-loan"
import { dispatchRepriceNotices } from "./reprice-notice-dispatch"
import { seedDefaultMessageTemplates } from "@/lib/messaging/default-templates"
import { sendMessage } from "@/lib/messaging/send"
import { dispatch } from "@/lib/messaging/providers"

vi.mock("@/lib/messaging/providers", async (original) => ({ ...(await original<typeof import("@/lib/messaging/providers")>()), dispatch: vi.fn() }))
const suite = process.env.RUN_ASSET_FINANCE_REPRICE_IT === "1" ? describe : describe.skip
const db = new PrismaClient()
suite("written rate notice outbox on PostgreSQL", () => {
  let tenant: RepriceTenant
  let loanId: string
  let effectiveDate: string
  beforeAll(async () => {
    tenant = await createRepriceTenant(db)
    loanId = await createRepriceLoan(db, tenant)
    effectiveDate = await recordPrime(db, tenant)
    await seedDefaultMessageTemplates(db, tenant.tenantId, "Synthetic rate lender")
  })
  afterAll(async () => { await db.$disconnect() })

  it("a failed transaction leaves neither repricing nor borrower notice", async () => {
    await expect(prisma.$transaction(async (tx) => {
      expect(await repriceLoanForReference(tx, { tenantId: tenant.tenantId, loanId, basis: "PRIME", effectiveDate, runDate: effectiveDate })).toMatchObject({ kind: "repriced" })
      throw new Error("synthetic rollback")
    })).rejects.toThrow("synthetic rollback")
    expect(await db.assetFinanceRateNotice.count({ where: { loanId } })).toBe(0)
    expect(await db.contractRate.count({ where: { loanId } })).toBe(1)
  })
  it("writes the recipient, new annual rate and both dates in the same repricing commit", async () => {
    await prisma.$transaction((tx) => repriceLoanForReference(tx, { tenantId: tenant.tenantId, loanId, basis: "PRIME", effectiveDate, runDate: effectiveDate }))
    const row = await db.assetFinanceRateNotice.findFirstOrThrow({ where: { loanId } })
    expect(row).toMatchObject({ tenantId: tenant.tenantId, recipientClientIds: [tenant.directorId], completedAt: null, effectiveDate: new Date(effectiveDate) })
    expect(row.resultingRate.toString()).toBe("0.13")
    const rate = await db.contractRate.findUniqueOrThrow({ where: { id: row.contractRateId } })
    expect(rate.newInstalmentCents).toBe(row.newInstalmentCents)
    await prisma.$transaction((tx) => repriceLoanForReference(tx, { tenantId: tenant.tenantId, loanId, basis: "PRIME", effectiveDate, runDate: effectiveDate }))
    expect(await db.assetFinanceRateNotice.count({ where: { loanId } })).toBe(1)
  })
  it("refuses attaching another tenant's notice to the contract rate", async () => {
    const row = await db.assetFinanceRateNotice.findFirstOrThrow({ where: { loanId } })
    await expect(db.assetFinanceRateNotice.update({ where: { id: row.id }, data: { tenantId: "synthetic-other-tenant" } })).rejects.toMatchObject({ code: "P2003" })
  })
  it("leaves an absent email contact pending with durable evidence", () => withoutTenantScope(async () => {
    const result = await dispatchRepriceNotices(prisma, tenant.tenantId)
    expect(result).toEqual({ completed: 0, pending: 1 })
    const row = await db.assetFinanceRateNotice.findFirstOrThrow({ where: { loanId } })
    expect(row.lastOutcomes).toMatchObject([{ clientId: tenant.directorId, status: "BLOCKED" }])
    expect(row.completedAt).toBeNull()
    expect(await db.auditLog.count({ where: { tenantId: tenant.tenantId, entityId: row.id, action: "ASSET_FINANCE_RATE_NOTICE_DISPATCH" } })).toBe(1)
  }))
  it("does not disclose an entity notice to a representative who no longer acts for it", () => withoutTenantScope(async () => {
    await db.entityRelationship.updateMany({ where: { tenantId: tenant.tenantId, entityId: tenant.entityId, clientId: tenant.directorId }, data: { active: false } })
    try {
      expect(await dispatchRepriceNotices(prisma, tenant.tenantId)).toEqual({ completed: 0, pending: 1 })
      const row = await db.assetFinanceRateNotice.findFirstOrThrow({ where: { loanId } })
      expect(row.lastOutcomes).toMatchObject([{ clientId: tenant.directorId, status: "BLOCKED", reason: "Recipient unavailable or deceased" }])
    } finally {
      await db.entityRelationship.updateMany({ where: { tenantId: tenant.tenantId, entityId: tenant.entityId, clientId: tenant.directorId }, data: { active: true } })
    }
  }))
  it("uses the real send pipeline once after commit, reserving a Message and conversation", () => withoutTenantScope(async () => {
    const recipient = await db.client.findUniqueOrThrow({ where: { id: tenant.directorId } })
    const contact = await db.contact.create({ data: { tenantId: tenant.tenantId, clientId: recipient.id, status: "CLIENT", firstSeenChannel: "MANUAL", firstSeenContext: "synthetic-rate-notice-test" } })
    await db.contactIdentity.create({ data: { tenantId: tenant.tenantId, contactId: contact.id, channel: "EMAIL", source: "MANUAL", value: recipient.email.toLowerCase() } })
    await db.emailConfig.create({ data: { tenantId: tenant.tenantId, provider: "IMAP_SMTP", fromName: "Synthetic lender", fromAddress: "sender@synthetic.invalid", smtpHost: "smtp.synthetic.invalid", smtpUser: "synthetic", smtpPass: "synthetic", active: true } })
    vi.mocked(dispatch).mockResolvedValue({ providerMessageId: "synthetic-rate-provider", acceptedAt: new Date() })
    expect(await dispatchRepriceNotices(prisma, tenant.tenantId, sendMessage)).toEqual({ completed: 1, pending: 0 })
    expect(await dispatchRepriceNotices(prisma, tenant.tenantId, sendMessage)).toEqual({ completed: 0, pending: 0 })
    expect(dispatch).toHaveBeenCalledTimes(1)
    const message = await db.message.findFirstOrThrow({ where: { tenantId: tenant.tenantId, idempotencyKey: { startsWith: "rate-notice:" } } })
    expect(message).toMatchObject({ status: "SENT", channel: "EMAIL" })
    expect(message.conversationId).toBeTruthy()
  }))
})
