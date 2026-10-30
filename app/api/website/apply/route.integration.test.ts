/**
 * Real-Postgres proof that a website conversion rolls back Client, Contact,
 * consent, Application, conversion links, and audit evidence together.
 *
 * Run only against a fully migrated throwaway database:
 *   RUN_DB_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run app/api/website/apply/route.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import { PrismaClient } from "@prisma/client"

const token = randomUUID().replaceAll("-", "")
const tenantId = `tenant_web_conversion_${token}`
const tenant = {
  id: tenantId,
  slug: `web-conversion-${token}`,
  name: "Website Conversion Transaction Test",
  domain: null,
}
const { getTenantFromRequestMock } = vi.hoisted(() => ({
  getTenantFromRequestMock: vi.fn(),
}))

vi.mock("@/lib/tenant", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/tenant")>()
  return { ...original, getTenantFromRequest: getTenantFromRequestMock }
})
vi.mock("@/lib/turnstile", () => ({
  verifyTurnstile: vi.fn().mockResolvedValue({ ok: true }),
}))
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn().mockReturnValue({ allowed: true, remaining: 9, retryAfterSeconds: 0 }),
  callerIp: vi.fn().mockReturnValue("127.0.0.1"),
  recordedCallerIp: vi.fn().mockReturnValue(null),
}))
vi.mock("@/lib/referral-agents/referrals", () => ({
  resolveReferralCode: vi.fn().mockResolvedValue(null),
  recordReferralEvent: vi.fn().mockResolvedValue(undefined),
}))
vi.mock("@/lib/messaging/send", () => ({ sendMessage: vi.fn() }))
vi.mock("@/lib/messaging/agent-message-template", () => ({
  getOrCreateAgentMessageTemplate: vi.fn(),
}))
vi.mock("@/lib/email/service", () => ({ sendEmail: vi.fn() }))

import { POST } from "./route"
import { purgeAuditRowsForTest } from "@/lib/audit/audit-rows.test-helpers"

const RUN = process.env.RUN_DB_IT === "1"
const suite = RUN ? describe : describe.skip

suite("POST /api/website/apply transaction boundary", () => {
  const db = new PrismaClient()
  const productId = `product_web_conversion_${token}`
  const email = `web-conversion-${token}@test.invalid`
  const triggerName = `web_conversion_fail_${token}`
  const functionName = `web_conversion_fail_fn_${token}`
  const activityTriggerName = `web_activity_fail_${token}`
  const activityFunctionName = `web_activity_fail_fn_${token}`

  beforeAll(async () => {
    getTenantFromRequestMock.mockResolvedValue(tenant)
    await db.tenant.create({ data: tenant })
    await db.loanProduct.create({
      data: {
        id: productId,
        tenantId,
        code: `WEB-${token}`,
        name: "Website Conversion Transaction Product",
        productType: "PERSONAL",
        minAmount: 100_000,
        maxAmount: 1_000_000,
        minTermDays: 30,
        maxTermDays: 90,
        interestRatePm: 0.03,
        interestModel: "DAILY_ACCRUAL",
        initiationFeePct: 0.15,
        initiationFeeMax: 105_000,
        monthlyServiceFee: 6_900,
      },
    })

    await db.$executeRawUnsafe(`
      CREATE FUNCTION "${functionName}"() RETURNS trigger AS $$
      BEGIN
        IF NEW."tenantId" = '${tenantId}' AND NEW."action" = 'LEAD_CONVERTED' THEN
          RAISE EXCEPTION 'synthetic lead conversion audit failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `)
    await db.$executeRawUnsafe(`
      CREATE TRIGGER "${triggerName}"
      BEFORE INSERT ON "AuditLog"
      FOR EACH ROW EXECUTE FUNCTION "${functionName}"()
    `)
    await db.$executeRawUnsafe(`
      CREATE FUNCTION "${activityFunctionName}"() RETURNS trigger AS $$
      BEGIN
        IF NEW."tenantId" = '${tenantId}' AND NEW."notes" LIKE '%Synthetic CRM activity failure%' THEN
          RAISE EXCEPTION 'synthetic initial CRM activity failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `)
    await db.$executeRawUnsafe(`
      CREATE TRIGGER "${activityTriggerName}"
      BEFORE INSERT ON "CrmActivity"
      FOR EACH ROW EXECUTE FUNCTION "${activityFunctionName}"()
    `)
  })

  afterAll(async () => {
    await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${activityTriggerName}" ON "CrmActivity"`)
    await db.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${activityFunctionName}"()`)
    await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${triggerName}" ON "AuditLog"`)
    await db.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${functionName}"()`)
    await db.contactIdentity.deleteMany({ where: { tenantId } })
    await db.contact.deleteMany({ where: { tenantId } })
    await db.consentRecord.deleteMany({ where: { tenantId } })
    await purgeAuditRowsForTest(db, { tenantId })
    await db.crmActivity.deleteMany({ where: { tenantId } })
    await db.loanApplication.deleteMany({ where: { tenantId } })
    await db.clientExpenseBreakdown.deleteMany({ where: { client: { tenantId } } })
    await db.client.deleteMany({ where: { tenantId } })
    await db.lead.deleteMany({ where: { tenantId } })
    await db.loanProduct.deleteMany({ where: { tenantId } })
    await db.tenant.delete({ where: { id: tenantId } })
    await db.$disconnect()
  })

  it("rejects a partial idempotency binding at the database boundary", async () => {
    const lead = await db.lead.create({
      data: {
        tenantId,
        firstName: "Synthetic",
        lastName: "Constraint",
        phone: "+27820000008",
        source: "WEBSITE",
        status: "NEW",
        tags: ["integration-test"],
      },
    })

    await expect(db.$executeRaw`
      UPDATE "Lead"
      SET "submissionKey" = ${randomUUID()}
      WHERE "id" = ${lead.id}
    `).rejects.toThrow()

    expect(await db.lead.findUniqueOrThrow({ where: { id: lead.id } })).toEqual(
      expect.objectContaining({
        submissionKey: null,
        submissionFingerprint: null,
        submissionReference: null,
      }),
    )
  })

  it("rolls back the enquiry when its mandatory initial CRM activity fails", async () => {
    const phone = "+27820000009"
    const response = await POST(new NextRequest(
      "https://staging.acme-lending.example/api/website/apply",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          firstName: "Synthetic",
          lastName: "ActivityRollback",
          phone,
          productType: "PERSONAL",
          amount: 5_000,
          purpose: "Synthetic CRM activity failure",
          turnstileToken: "integration-test",
          submissionKey: randomUUID(),
        }),
      },
    ))

    expect(response.status).toBe(500)
    expect(await db.lead.count({ where: { tenantId, phone } })).toBe(0)
    expect(await db.crmActivity.count({ where: { tenantId } })).toBe(0)
  })

  it("keeps only the enquiry lead when the mandatory conversion audit fails", async () => {
    const response = await POST(new NextRequest(
      "https://staging.acme-lending.example/api/website/apply",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          firstName: "Synthetic",
          lastName: "Rollback",
          email,
          phone: "+27820000000",
          idNumber: "8001015000086",
          employmentStatus: "EMPLOYED",
          employerName: "Synthetic Employer",
          monthlyIncome: 15_000,
          monthlyExpenses: 5_000,
          productType: "PERSONAL",
          amount: 5_000,
          termDays: 30,
          purpose: "Synthetic integration test",
          popiaConsent: true,
          turnstileToken: "integration-test",
        }),
      },
    ))

    expect(response.status).toBe(500)
    const lead = await db.lead.findFirstOrThrow({ where: { tenantId, email } })
    expect(lead).toEqual(expect.objectContaining({
      status: "NEW",
      convertedToClientId: null,
      convertedToApplicationId: null,
    }))
    expect(await db.crmActivity.count({ where: { tenantId, leadId: lead.id } })).toBe(1)
    expect(await db.client.count({ where: { tenantId, email } })).toBe(0)
    expect(await db.loanApplication.count({ where: { tenantId } })).toBe(0)
    expect(await db.consentRecord.count({ where: { tenantId } })).toBe(0)
    expect(await db.contact.count({ where: { tenantId, clientId: { not: null } } })).toBe(0)
    expect(await db.auditLog.count({ where: { tenantId } })).toBe(0)
  })
})

suite("POST /api/website/apply idempotent concurrency", () => {
  const db = new PrismaClient()
  const idempotentTenantId = `${tenantId}_idempotent`
  const idempotentTenant = {
    id: idempotentTenantId,
    slug: `web-idempotent-${token}`,
    name: "Website Idempotency Test",
    domain: null,
  }
  const productId = `product_web_idempotent_${token}`
  const email = `web-idempotent-${token}@test.invalid`

  beforeAll(async () => {
    getTenantFromRequestMock.mockResolvedValue(idempotentTenant)
    await db.tenant.create({ data: idempotentTenant })
    await db.loanProduct.create({
      data: {
        id: productId,
        tenantId: idempotentTenantId,
        code: `WEB-IDEMP-${token}`,
        name: "Website Idempotency Product",
        productType: "PERSONAL",
        minAmount: 100_000,
        maxAmount: 1_000_000,
        minTermDays: 30,
        maxTermDays: 90,
        interestRatePm: 0.03,
        interestModel: "DAILY_ACCRUAL",
        initiationFeePct: 0.15,
        initiationFeeMax: 105_000,
        monthlyServiceFee: 6_900,
      },
    })
  })

  afterAll(async () => {
    await db.contactIdentity.deleteMany({ where: { tenantId: idempotentTenantId } })
    await db.contact.deleteMany({ where: { tenantId: idempotentTenantId } })
    await db.consentRecord.deleteMany({ where: { tenantId: idempotentTenantId } })
    await purgeAuditRowsForTest(db, { tenantId: idempotentTenantId })
    await db.crmActivity.deleteMany({ where: { tenantId: idempotentTenantId } })
    await db.lead.deleteMany({ where: { tenantId: idempotentTenantId } })
    await db.loanApplication.deleteMany({ where: { tenantId: idempotentTenantId } })
    await db.clientExpenseBreakdown.deleteMany({
      where: { client: { tenantId: idempotentTenantId } },
    })
    await db.client.deleteMany({ where: { tenantId: idempotentTenantId } })
    await db.loanProduct.deleteMany({ where: { tenantId: idempotentTenantId } })
    await db.tenant.delete({ where: { id: idempotentTenantId } })
    await db.$disconnect()
  })

  it("turns simultaneous identical requests into one enquiry and one application", async () => {
    const submissionKey = randomUUID()
    const body = {
      firstName: "Synthetic",
      lastName: "Concurrent",
      email,
      phone: "+27820000001",
      idNumber: "8001015000086",
      employmentStatus: "EMPLOYED",
      employerName: "Synthetic Employer",
      monthlyIncome: 15_000,
      monthlyExpenses: 5_000,
      productType: "PERSONAL",
      amount: 5_000,
      termDays: 30,
      purpose: "Synthetic concurrent integration test",
      popiaConsent: true,
      turnstileToken: "integration-test",
      submissionKey,
    }
    const request = () => POST(new NextRequest(
      "https://staging.acme-lending.example/api/website/apply",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    ))

    const responses = await Promise.all([request(), request()])
    const results = await Promise.all(responses.map((response) => response.json()))

    expect(responses.map((response) => response.status)).toEqual([200, 200])
    expect(results[0]).toEqual(results[1])
    expect(results[0]).toEqual(expect.objectContaining({
      success: true,
      applicationId: expect.any(String),
      reference: expect.any(String),
      portalAccountStatus: "activation_required",
    }))

    const lead = await db.lead.findFirstOrThrow({
      where: { tenantId: idempotentTenantId, submissionKey },
    })
    expect(lead).toEqual(expect.objectContaining({
      status: "CONVERTED",
      submissionFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
      submissionReference: results[0].reference,
      convertedToApplicationId: results[0].applicationId,
    }))
    expect(await db.lead.count({ where: { tenantId: idempotentTenantId } })).toBe(1)
    expect(await db.crmActivity.count({
      where: { tenantId: idempotentTenantId, leadId: lead.id },
    })).toBe(1)
    expect(await db.client.count({ where: { tenantId: idempotentTenantId, email } })).toBe(1)
    expect(await db.loanApplication.count({
      where: { tenantId: idempotentTenantId },
    })).toBe(1)
    expect(await db.auditLog.count({
      where: {
        tenantId: idempotentTenantId,
        action: "APPLICATION_SUBMITTED_BY_CLIENT",
      },
    })).toBe(1)
    expect(await db.auditLog.count({
      where: {
        tenantId: idempotentTenantId,
        action: "LEAD_CONVERTED",
      },
    })).toBe(1)
  })

})
