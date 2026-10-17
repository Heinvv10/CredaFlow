/** Migrated PG deadlines: fixture classification only is installed before the
 * real queue, scan and dispatch operations, which run with every guard active. */
import { PrismaClient } from "@prisma/client"
import { afterAll, describe, expect, it, vi } from "vitest"
import { prisma } from "@/lib/prisma"
import { withoutTenantScope } from "@/lib/tenant-scope"
import { createRepriceLoan, createRepriceTenant } from "./reprice.integration-fixture"
import { queueRepriceNotice } from "./reprice-notice"
import { scanRateNoticeDeadlines } from "./rate-notice-deadline"
import { dispatchRepriceNotices } from "./reprice-notice-dispatch"
import { seedDefaultMessageTemplates } from "@/lib/messaging/default-templates"
const suite = process.env.RUN_ASSET_FINANCE_REPRICE_IT === "1" ? describe : describe.skip
const db = new PrismaClient()
suite.sequential("NCA written-rate deadline and historical breach on PostgreSQL", () => {
  afterAll(async () => {
    vi.useRealTimers()
    await db.$disconnect()
  })
  async function setup() {
    const tenant = await createRepriceTenant(db, false),
      loanId = await createRepriceLoan(db, tenant)
    const rate = await db.contractRate.findFirstOrThrow({ where: { loanId } })
    // This fixture tests the notice obligation, not underwriting/PASQ. The
    // existing signed cash fixture is classified before testing the service.
    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL session_replication_role=replica")
      await tx.loan.update({ where: { id: loanId }, data: { ncaRegime: "NCA" } })
      await tx.contractRate.update({
        where: { id: rate.id },
        data: { effectiveDate: new Date("2026-04-02T00:00:00Z") },
      })
    })
    await prisma.$transaction((tx) =>
      queueRepriceNotice(tx, {
        tenantId: tenant.tenantId,
        loanId,
        entityId: tenant.entityId,
        loanReference: "SYNTHETIC DEADLINE",
        contractRateId: rate.id,
        resultingRate: ".13",
        effectiveDate: "2026-04-02",
        firstChangedPaymentDate: "2026-05-01",
        oldInstalmentCents: 100,
        newInstalmentCents: 110,
        totalInterestCents: 1000,
        monthlyInterestCents: 100,
      })
    )
    return { tenant, loanId, notice: await db.assetFinanceRateNotice.findFirstOrThrow({ where: { loanId } }) }
  }
  it("persists the holiday-aware actual-date deadline and rejects postponing it", () =>
    withoutTenantScope(async () => {
      const { notice } = await setup()
      expect(notice.statutoryDueOn?.toISOString().slice(0, 10)).toBe("2026-05-20")
      expect(notice.createdAt.toISOString().slice(0, 10) > "2026-05-20").toBe(true)
      await expect(
        db.assetFinanceRateNotice.update({
          where: { id: notice.id },
          data: { statutoryDueOn: new Date("2027-01-01Z") },
        })
      ).rejects.toThrow("Rate notice statutory obligation is immutable")
      await expect(
        db.assetFinanceRateNotice.create({
          data: {
            ...notice,
            taxDocuments: undefined,
            lastOutcomes: undefined,
            id: "synthetic-forged-effective",
            effectiveDate: new Date("2026-05-01Z"),
          },
        })
      ).rejects.toThrow("Rate notice deadline must follow actual effective date and NCA regime")
    }))
  it("alerts once per deadline stage, keeps partial delivery pending, and preserves breach after late completion", () =>
    withoutTenantScope(async () => {
      const { tenant, loanId, notice } = await setup()
      const notifications = () => db.notification.count({ where: { tenantId: tenant.tenantId, entityId: loanId } })
      const start = await notifications()
      for (const [today, level] of [
        ["2026-05-18", 1],
        ["2026-05-20", 2],
        ["2026-05-21", 3],
      ] as const) {
        await scanRateNoticeDeadlines(prisma, today)
        const once = await notifications()
        expect(once).toBeGreaterThan(start)
        await scanRateNoticeDeadlines(prisma, today)
        expect(await notifications()).toBe(once)
        expect(
          (await db.assetFinanceRateNotice.findUniqueOrThrow({ where: { id: notice.id } })).deadlineEscalationLevel
        ).toBe(level)
      }
      await seedDefaultMessageTemplates(db, tenant.tenantId, "Synthetic notice lender")
      const client = await db.client.findUniqueOrThrow({ where: { id: tenant.directorId } })
      const contact = await db.contact.create({
        data: { tenantId: tenant.tenantId, firstSeenChannel: "MANUAL", status: "CLIENT", clientId: client.id },
      })
      await db.contactIdentity.create({
        data: {
          tenantId: tenant.tenantId,
          contactId: contact.id,
          channel: "EMAIL",
          source: "MANUAL",
          value: client.email!.toLowerCase(),
        },
      })
      await db.assetFinanceRateNotice.update({
        where: { id: notice.id },
        data: { recipientClientIds: [tenant.directorId, "synthetic-missing-representative"] },
      })
      vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-05-22T08:00:00Z") })
      const send = vi.fn(async () => ({ id: "synthetic-provider-accepted", status: "SENT", sentAt: new Date() }))
      expect(await dispatchRepriceNotices(prisma, tenant.tenantId, send as never)).toEqual({ completed: 0, pending: 1 })
      const partial = await db.assetFinanceRateNotice.findUniqueOrThrow({ where: { id: notice.id } })
      expect(partial.firstDispatchedAt).toBeNull()
      expect(partial.lastOutcomes).toMatchObject([{ status: "SENT" }, { status: "BLOCKED" }])
      // Resolve the missing representative and contact; both original required
      // recipients must now receive the notice, rather than dropping a leg.
      const second = await db.client.create({
        data: {
          id: "synthetic-missing-representative",
          tenantId: tenant.tenantId,
          idNumber: `synthetic-${tenant.tenantId}`,
          firstName: "SYNTHETIC",
          lastName: "SECOND",
          email: "second@synthetic.invalid",
          phone: "0000000000",
        },
      })
      await db.entityRelationship.create({
        data: {
          tenantId: tenant.tenantId,
          entityId: tenant.entityId,
          clientId: second.id,
          role: "AUTHORISED_SIGNATORY",
        },
      })
      const secondContact = await db.contact.create({
        data: { tenantId: tenant.tenantId, firstSeenChannel: "MANUAL", status: "CLIENT", clientId: second.id },
      })
      await db.contactIdentity.create({
        data: {
          tenantId: tenant.tenantId,
          contactId: secondContact.id,
          channel: "EMAIL",
          source: "MANUAL",
          value: second.email!,
        },
      })
      expect(await dispatchRepriceNotices(prisma, tenant.tenantId, send as never)).toEqual({ completed: 1, pending: 0 })
      await scanRateNoticeDeadlines(prisma, "2026-05-22")
      const done = await db.assetFinanceRateNotice.findUniqueOrThrow({ where: { id: notice.id } })
      expect(done.firstDispatchedAt).toEqual(new Date("2026-05-22T08:00:00Z"))
      expect(done.deadlineExceptionAt).toEqual(partial.deadlineExceptionAt)
      expect(done.deadlineEscalationLevel).toBe(3)
      await expect(
        db.assetFinanceRateNotice.update({ where: { id: notice.id }, data: { deadlineExceptionAt: null } })
      ).rejects.toThrow("Rate notice compliance history cannot be cleared")
      vi.useRealTimers()
    }))
})
