/**
 * Real-Postgres proof that the normal staff lead-conversion route promotes
 * the Contact provisioned by the lead-create path instead of creating a
 * second Contact that collides on its email/phone identities.
 *
 * Run only against a fully migrated throwaway database:
 *   RUN_DB_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run app/api/crm/leads/[id]/convert/route.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import { PrismaClient } from "@prisma/client"
import { provisionContactForClient, provisionContactForLead } from "@/lib/contact/provision"

const token = randomUUID().replaceAll("-", "")
const tenantId = `tenant_staff_conversion_${token}`
const userId = `user_staff_conversion_${token}`
const leadId = `lead_staff_conversion_${token}`
const productId = `product_staff_conversion_${token}`
const email = `staff-conversion-${token}@test.invalid`
const phone = "+27820000101"
const normalisedPhone = "27820000101"

const { requireApiRoleMock } = vi.hoisted(() => ({
  requireApiRoleMock: vi.fn(),
}))

vi.mock("@/lib/auth-guards", () => ({
  requireApiRole: () => requireApiRoleMock(),
}))
// The real withTenantContext lazily imports @/lib/auth, whose next-auth import
// of "next/server" does not resolve under vitest's Node ESM loader. Its session
// is bound to this tenant, so the principal/tenant check still runs.
vi.mock("@/lib/auth", () => ({
  auth: async () => ({ user: { id: userId, tenantId } }),
}))

import { POST } from "./route"

const RUN = process.env.RUN_DB_IT === "1"
const suite = RUN ? describe : describe.skip

suite("POST /api/crm/leads/[id]/convert Contact promotion", () => {
  const db = new PrismaClient()

  beforeAll(async () => {
    requireApiRoleMock.mockResolvedValue({
      user: {
        id: userId,
        name: "Integration Credit Officer",
        email: `officer-${token}@test.invalid`,
      },
    })
    await db.tenant.create({
      data: {
        id: tenantId,
        slug: `staff-conversion-${token}`,
        name: "Staff Lead Conversion Integration Test",
      },
    })
    await db.user.create({
      data: {
        id: userId,
        tenantId,
        email: `officer-${token}@test.invalid`,
        name: "Integration Credit Officer",
        password: "not-a-login-credential",
        role: "CREDIT_OFFICER",
      },
    })
    await db.loanProduct.create({
      data: {
        id: productId,
        tenantId,
        code: `STAFF-CONVERT-${token}`,
        name: "Staff Conversion Product",
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
    await db.$transaction(async (tx) => {
      await tx.lead.create({
        data: {
          id: leadId,
          tenantId,
          firstName: "Synthetic",
          lastName: "Staff Conversion",
          email,
          phone,
          source: "MANUAL",
          status: "QUALIFIED",
          tags: [],
        },
      })
      // The application client is Prisma-extended; this seed client is the
      // vanilla generated client, but both expose the same delegates used by
      // the helper at runtime.
      await provisionContactForLead(tx as never, {
        tenantId,
        leadId,
        firstName: "Synthetic",
        lastName: "Staff Conversion",
        email,
        phone,
        source: "MANUAL",
      })
    })
  })

  afterAll(async () => {
    await db.contactIdentity.deleteMany({ where: { tenantId } })
    await db.contact.deleteMany({ where: { tenantId } })
    await db.auditLog.deleteMany({ where: { tenantId } })
    await db.crmActivity.deleteMany({ where: { tenantId } })
    await db.lead.deleteMany({ where: { tenantId } })
    await db.loanApplication.deleteMany({ where: { tenantId } })
    await db.clientExpenseBreakdown.deleteMany({ where: { client: { tenantId } } })
    await db.client.deleteMany({ where: { tenantId } })
    await db.loanProduct.deleteMany({ where: { tenantId } })
    await db.user.deleteMany({ where: { tenantId } })
    await db.tenant.delete({ where: { id: tenantId } })
    await db.$disconnect()
  })

  it("refuses a term above the product maximum and writes nothing", async () => {
    const response = await POST(new NextRequest(
      `http://localhost/api/crm/leads/${leadId}/convert`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-tenant-slug": `staff-conversion-${token}`,
        },
        body: JSON.stringify({
          idNumber: `800101${token.slice(0, 7)}`,
          firstName: "Synthetic",
          lastName: "Staff Conversion",
          email,
          phone,
          employmentStatus: "EMPLOYED",
          employerName: "Synthetic Employer",
          monthlyIncome: 15_000,
          monthlyExpenses: 8_000,
          appliedAmount: 5_000,
          appliedTermDays: 91,
          productId,
          purpose: "Synthetic integration test",
        }),
      },
    ), { params: Promise.resolve({ id: leadId }) })

    expect(response.status).toBe(422)
    expect((await response.json()).error).toBe(
      "Term must be between 30 and 90 days for Staff Conversion Product.",
    )
    const [lead, clients, applications] = await Promise.all([
      db.lead.findUniqueOrThrow({ where: { id: leadId } }),
      db.client.count({ where: { tenantId } }),
      db.loanApplication.count({ where: { tenantId } }),
    ])
    expect(lead).toEqual(expect.objectContaining({
      status: "QUALIFIED",
      convertedToClientId: null,
      convertedToApplicationId: null,
    }))
    expect(clients).toBe(0)
    expect(applications).toBe(0)
  })

  it("refuses an amount above the product maximum and writes nothing", async () => {
    const response = await POST(new NextRequest(
      `http://localhost/api/crm/leads/${leadId}/convert`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-tenant-slug": `staff-conversion-${token}`,
        },
        body: JSON.stringify({
          idNumber: `800101${token.slice(0, 7)}`,
          firstName: "Synthetic",
          lastName: "Staff Conversion",
          email,
          phone,
          employmentStatus: "EMPLOYED",
          employerName: "Synthetic Employer",
          monthlyIncome: 15_000,
          monthlyExpenses: 8_000,
          appliedAmount: 10_000.01,
          appliedTermDays: 30,
          productId,
          purpose: "Synthetic integration test",
        }),
      },
    ), { params: Promise.resolve({ id: leadId }) })

    expect(response.status).toBe(422)
    expect((await response.json()).error).toBe(
      "Amount must be between R1,000 and R10,000 for Staff Conversion Product.",
    )
    const [lead, clients, applications] = await Promise.all([
      db.lead.findUniqueOrThrow({ where: { id: leadId } }),
      db.client.count({ where: { tenantId } }),
      db.loanApplication.count({ where: { tenantId } }),
    ])
    expect(lead).toEqual(expect.objectContaining({
      status: "QUALIFIED",
      convertedToClientId: null,
      convertedToApplicationId: null,
    }))
    expect(clients).toBe(0)
    expect(applications).toBe(0)
  })

  it("refuses recoveryApplicationId on an unlinked lead and writes nothing", async () => {
    // The route zeroes the loan inputs when recoveryApplicationId is set, so
    // only a product with minAmount 0 lets the old code reach the writes.
    const zeroMinProductId = `${productId}_zero`
    await db.loanProduct.create({
      data: {
        id: zeroMinProductId,
        tenantId,
        code: `STAFF-CONVERT-ZERO-${token}`,
        name: "Staff Conversion Zero Minimum Product",
        productType: "PERSONAL",
        minAmount: 0,
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
    const response = await POST(new NextRequest(
      `http://localhost/api/crm/leads/${leadId}/convert`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-tenant-slug": `staff-conversion-${token}`,
        },
        body: JSON.stringify({
          idNumber: `800101${token.slice(0, 7)}`,
          firstName: "Synthetic",
          lastName: "Staff Conversion",
          email,
          phone,
          employmentStatus: "EMPLOYED",
          employerName: "Synthetic Employer",
          monthlyIncome: 15_000,
          monthlyExpenses: 8_000,
          appliedAmount: 5_000,
          appliedTermDays: 30,
          productId: zeroMinProductId,
          purpose: "Synthetic integration test",
          recoveryApplicationId: "app-x",
          recoveryReason: "Synthetic recovery reason",
        }),
      },
    ), { params: Promise.resolve({ id: leadId }) })

    expect(response.status).toBe(422)
    expect((await response.json()).error).toMatch(/no linked client/i)
    const [lead, clients, applications] = await Promise.all([
      db.lead.findUniqueOrThrow({ where: { id: leadId } }),
      db.client.count({ where: { tenantId } }),
      db.loanApplication.count({ where: { tenantId } }),
    ])
    expect(lead).toEqual(expect.objectContaining({
      status: "QUALIFIED",
      convertedToClientId: null,
      convertedToApplicationId: null,
    }))
    expect(clients).toBe(0)
    expect(applications).toBe(0)
  })

  it("commits one dual-linked Contact, retained identities, and exact conversion evidence", async () => {
    const before = await db.contact.findFirstOrThrow({
      where: { tenantId, leadId },
      include: { identities: { orderBy: { channel: "asc" } } },
    })
    expect(before).toEqual(expect.objectContaining({
      clientId: null,
      leadId,
      status: "LEAD",
    }))
    expect(before.identities.map(({ channel, value }) => ({ channel, value }))).toEqual([
      { channel: "EMAIL", value: email },
      { channel: "SMS", value: normalisedPhone },
    ])

    const response = await POST(new NextRequest(
      `http://localhost/api/crm/leads/${leadId}/convert`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-tenant-slug": `staff-conversion-${token}`,
        },
        body: JSON.stringify({
          idNumber: `800101${token.slice(0, 7)}`,
          firstName: "Synthetic",
          lastName: "Staff Conversion",
          email,
          phone,
          employmentStatus: "EMPLOYED",
          employerName: "Synthetic Employer",
          monthlyIncome: 15_000,
          monthlyExpenses: 8_000,
          appliedAmount: 5_000,
          appliedTermDays: 30,
          productId,
          purpose: "Synthetic integration test",
        }),
      },
    ), { params: Promise.resolve({ id: leadId }) })

    expect(response.status).toBe(200)
    const payload = await response.json()
    expect(payload).toEqual(expect.objectContaining({
      applicationReference: expect.stringMatching(/^APP-/),
      recovered: false,
      alreadyConverted: false,
    }))

    const [lead, client, application, contacts, audits] = await Promise.all([
      db.lead.findUniqueOrThrow({ where: { id: leadId } }),
      db.client.findUniqueOrThrow({ where: { id: payload.clientId } }),
      db.loanApplication.findUniqueOrThrow({ where: { id: payload.applicationId } }),
      db.contact.findMany({
        where: {
          tenantId,
          OR: [{ leadId }, { clientId: payload.clientId }],
        },
        include: { identities: { orderBy: { channel: "asc" } } },
      }),
      db.auditLog.findMany({ where: { tenantId }, orderBy: { createdAt: "asc" } }),
    ])

    expect(lead).toEqual(expect.objectContaining({
      status: "CONVERTED",
      convertedToClientId: client.id,
      convertedToApplicationId: application.id,
      conversionRecoveryRequired: false,
    }))
    expect(application.clientId).toBe(client.id)
    expect(contacts).toHaveLength(1)
    expect(contacts[0]).toEqual(expect.objectContaining({
      id: before.id,
      leadId,
      clientId: client.id,
      status: "CLIENT",
    }))
    expect(contacts[0].identities.map(({ channel, value }) => ({ channel, value }))).toEqual([
      { channel: "EMAIL", value: email },
      { channel: "SMS", value: normalisedPhone },
    ])
    expect(audits.map((audit) => audit.action)).toEqual(expect.arrayContaining([
      "CONTACT_PROMOTED_LEAD_TO_CLIENT",
      "APPLICATION_SUBMITTED_BY_STAFF",
      "CLIENT_CREATED",
      "LEAD_CONVERTED",
    ]))
  })

  it("recovers a repeat Client without replacing the Contact's earlier lead link", async () => {
    const clientId = `client_repeat_${token}`
    const leadAId = `lead_repeat_a_${token}`
    const leadBId = `lead_repeat_b_${token}`
    const applicationAId = `application_repeat_a_${token}`
    const applicationBId = `application_repeat_b_${token}`
    const repeatEmail = `repeat-client-${token}@test.invalid`
    const repeatPhone = "+27820000102"

    await db.client.create({
      data: {
        id: clientId,
        tenantId,
        reference: `CLT-REPEAT-${token}`,
        idNumber: `repeat-id-${token}`,
        firstName: "Repeat",
        lastName: "Client",
        email: repeatEmail,
        phone: repeatPhone,
      },
    })
    await db.loanApplication.createMany({
      data: [
        {
          id: applicationAId,
          tenantId,
          reference: `APP-REPEAT-A-${token}`,
          clientId,
          productId,
          appliedAmount: 400_000,
          appliedTermDays: 30,
          // Neither status is what this test is about: the route never reads
          // it. DISBURSED is unreachable by a bare insert (the PASQ approval
          // trigger), and only one of the two may be open for this product.
          status: "DECLINED",
        },
        {
          id: applicationBId,
          tenantId,
          reference: `APP-REPEAT-B-${token}`,
          clientId,
          productId,
          appliedAmount: 500_000,
          appliedTermDays: 30,
          status: "SUBMITTED",
        },
      ],
    })
    await db.lead.createMany({
      data: [
        {
          id: leadAId,
          tenantId,
          firstName: "Repeat",
          lastName: "First Lead",
          email: repeatEmail,
          phone: repeatPhone,
          status: "CONVERTED",
          tags: [],
          convertedToClientId: clientId,
          convertedToApplicationId: applicationAId,
        },
        {
          id: leadBId,
          tenantId,
          firstName: "Repeat",
          lastName: "Second Lead",
          email: repeatEmail,
          phone: repeatPhone,
          status: "CONVERTED",
          tags: [],
          convertedToClientId: clientId,
          conversionRecoveryRequired: true,
        },
      ],
    })
    const firstContact = await db.$transaction(async (tx) => {
      const provisioned = await provisionContactForLead(tx as never, {
        tenantId,
        leadId: leadAId,
        firstName: "Repeat",
        lastName: "Client",
        email: repeatEmail,
        phone: repeatPhone,
      })
      return tx.contact.update({
        where: { id: provisioned.contact.id },
        data: { clientId, status: "CLIENT" },
      })
    })
    await db.auditLog.create({
      data: {
        tenantId,
        userId,
        userEmail: `officer-${token}@test.invalid`,
        action: "APPLICATION_SUBMITTED_BY_STAFF",
        entity: "LoanApplication",
        entityId: applicationBId,
        newValue: { leadId: leadBId, clientId },
      },
    })

    const response = await POST(new NextRequest(
      `http://localhost/api/crm/leads/${leadBId}/convert`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-tenant-slug": `staff-conversion-${token}`,
        },
        body: JSON.stringify({
          recoveryApplicationId: applicationBId,
          recoveryReason: "Repeat client application verified from its submission audit",
        }),
      },
    ), { params: Promise.resolve({ id: leadBId }) })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(expect.objectContaining({
      clientId,
      applicationId: applicationBId,
      recovered: true,
      alreadyConverted: true,
    }))
    expect(await db.lead.findUniqueOrThrow({ where: { id: leadBId } })).toEqual(
      expect.objectContaining({
        convertedToClientId: clientId,
        convertedToApplicationId: applicationBId,
        conversionRecoveryRequired: false,
      }),
    )
    expect(await db.contact.findUniqueOrThrow({ where: { id: firstContact.id } })).toEqual(
      expect.objectContaining({ clientId, leadId: leadAId, status: "CLIENT" }),
    )
    expect(await db.contact.count({ where: { tenantId, clientId } })).toBe(1)
    const reuseAudit = await db.auditLog.findFirstOrThrow({
      where: {
        tenantId,
        entityId: firstContact.id,
        action: "CONTACT_REUSED_FOR_LEAD_CONVERSION",
      },
    })
    expect(reuseAudit.newValue).toEqual(expect.objectContaining({
      leadId: leadAId,
      conversionLeadId: leadBId,
      clientId,
      resolution: "REUSED_CLIENT_CONTACT",
    }))
  })

  it("recovers a split legacy Lead/Client Contact pair without a forced merge", async () => {
    const clientId = `client_split_${token}`
    const splitLeadId = `lead_split_${token}`
    const clientEmail = `split-client-${token}@test.invalid`
    const clientPhone = "+27820000103"
    const leadEmail = `split-lead-${token}@test.invalid`
    const leadPhone = "+27820000104"

    await db.client.create({
      data: {
        id: clientId,
        tenantId,
        reference: `CLT-SPLIT-${token}`,
        idNumber: `split-id-${token}`,
        firstName: "Split",
        lastName: "Client",
        email: clientEmail,
        phone: clientPhone,
        employmentStatus: "EMPLOYED",
        employerName: "Synthetic Employer",
        monthlyIncome: 1_500_000,
        monthlyExpenses: 800_000,
        expenseBreakdown: {
          create: {
            housing: 0,
            transport: 0,
            food: 0,
            education: 0,
            insurance: 0,
            clothing: 0,
            entertainment: 0,
            medical: 0,
            other: 800_000,
          },
        },
      },
    })
    await db.lead.create({
      data: {
        id: splitLeadId,
        tenantId,
        firstName: "Split",
        lastName: "Lead",
        email: leadEmail,
        phone: leadPhone,
        status: "CONVERTED",
        tags: [],
        convertedToClientId: clientId,
        conversionRecoveryRequired: true,
      },
    })
    const [clientContact, leadContact] = await db.$transaction(async (tx) => {
      const clientResult = await provisionContactForClient(tx as never, {
        tenantId,
        clientId,
        firstName: "Split",
        lastName: "Client",
        email: clientEmail,
        phone: clientPhone,
      })
      const leadResult = await provisionContactForLead(tx as never, {
        tenantId,
        leadId: splitLeadId,
        firstName: "Split",
        lastName: "Lead",
        email: leadEmail,
        phone: leadPhone,
      })
      return [clientResult.contact, leadResult.contact]
    })

    const response = await POST(new NextRequest(
      `http://localhost/api/crm/leads/${splitLeadId}/convert`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-tenant-slug": `staff-conversion-${token}`,
        },
        body: JSON.stringify({
          idNumber: `split-id-${token}`,
          firstName: "Split",
          lastName: "Client",
          email: clientEmail,
          phone: clientPhone,
          employmentStatus: "EMPLOYED",
          employerName: "Synthetic Employer",
          monthlyIncome: 15_000,
          monthlyExpenses: 8_000,
          appliedAmount: 5_000,
          appliedTermDays: 30,
          productId,
          purpose: "Synthetic split-contact recovery",
          recoveryReason: "Legacy split contacts preserved pending explicit audited merge",
        }),
      },
    ), { params: Promise.resolve({ id: splitLeadId }) })

    expect(response.status).toBe(200)
    const payload = await response.json()
    expect(payload).toEqual(expect.objectContaining({
      clientId,
      recovered: true,
      alreadyConverted: false,
    }))
    expect(await db.lead.findUniqueOrThrow({ where: { id: splitLeadId } })).toEqual(
      expect.objectContaining({
        convertedToClientId: clientId,
        convertedToApplicationId: payload.applicationId,
        conversionRecoveryRequired: false,
      }),
    )
    expect(await db.contact.findUniqueOrThrow({ where: { id: clientContact.id } })).toEqual(
      expect.objectContaining({ clientId, leadId: null, status: "CLIENT" }),
    )
    expect(await db.contact.findUniqueOrThrow({ where: { id: leadContact.id } })).toEqual(
      expect.objectContaining({ clientId: null, leadId: splitLeadId, status: "LEAD" }),
    )
    expect(await db.contact.count({
      where: { tenantId, OR: [{ clientId }, { leadId: splitLeadId }] },
    })).toBe(2)
    const splitReuseAudit = await db.auditLog.findFirstOrThrow({
      where: {
        tenantId,
        entityId: clientContact.id,
        action: "CONTACT_REUSED_FOR_LEAD_CONVERSION",
      },
    })
    expect(splitReuseAudit.newValue).toEqual(expect.objectContaining({
      leadId: null,
      conversionLeadId: splitLeadId,
      clientId,
      resolution: "REUSED_CLIENT_CONTACT",
    }))
  })
})
