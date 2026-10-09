/**
 * Real-Postgres proof for the post-migration lead-link invariants.
 *
 * Run only against a fully migrated throwaway database:
 *   RUN_DB_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/crm/lead-conversion.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { PrismaClient } from "@prisma/client"

const token = randomUUID().replaceAll("-", "")
const tenantId = `tenant_lead_links_${token}`
const clientAId = `client_lead_links_a_${token}`
const clientBId = `client_lead_links_b_${token}`
const applicationAId = `application_lead_links_a_${token}`
const productId = `product_lead_links_${token}`

const RUN = process.env.RUN_DB_IT === "1"
const suite = RUN ? describe : describe.skip

suite("lead conversion database invariants", () => {
  const db = new PrismaClient()

  beforeAll(async () => {
    await db.tenant.create({
      data: {
        id: tenantId,
        slug: `lead-links-${token}`,
        name: "Lead Link Integration Test",
      },
    })
    await db.loanProduct.create({
      data: {
        id: productId,
        tenantId,
        code: `LEAD-${token}`,
        name: "Lead Link Test Product",
        productType: "PERSONAL",
        minAmount: 100_000,
        maxAmount: 1_000_000,
        minTermDays: 30,
        maxTermDays: 90,
        interestRatePm: 0.03,
        interestModel: "DAILY_ACCRUAL",
      },
    })
    await db.client.createMany({
      data: [
        {
          id: clientAId,
          tenantId,
          reference: `CLI-A-${token}`,
          idNumber: `A-${token}`,
          firstName: "Client",
          lastName: "A",
          email: `client-a-${token}@test.invalid`,
          phone: "+27820000001",
        },
        {
          id: clientBId,
          tenantId,
          reference: `CLI-B-${token}`,
          idNumber: `B-${token}`,
          firstName: "Client",
          lastName: "B",
          email: `client-b-${token}@test.invalid`,
          phone: "+27820000002",
        },
      ],
    })
    await db.loanApplication.create({
      data: {
        id: applicationAId,
        tenantId,
        reference: `APP-A-${token}`,
        clientId: clientAId,
        productId,
        appliedAmount: 500_000,
        appliedTermDays: 30,
        status: "SUBMITTED",
      },
    })
  })

  afterAll(async () => {
    await db.lead.deleteMany({ where: { tenantId } })
    await db.loanApplication.deleteMany({ where: { tenantId } })
    await db.client.deleteMany({ where: { tenantId } })
    await db.loanProduct.deleteMany({ where: { tenantId } })
    await db.tenant.delete({ where: { id: tenantId } })
    await db.$disconnect()
  })

  it("rejects the legacy non-CONVERTED status plus conversion-link writer shape", async () => {
    await expect(db.lead.create({
      data: {
        tenantId,
        firstName: "Legacy",
        lastName: "Writer",
        phone: "+27821000001",
        status: "QUALIFIED",
        tags: [],
        convertedToClientId: clientAId,
      },
    })).rejects.toThrow()

    expect(await db.lead.count({
      where: { tenantId, firstName: "Legacy", lastName: "Writer" },
    })).toBe(0)
  })

  it("accepts a separate portal-account link without claiming conversion", async () => {
    const lead = await db.lead.create({
      data: {
        tenantId,
        firstName: "Portal",
        lastName: "Account",
        phone: "+27821000002",
        status: "QUALIFIED",
        tags: [],
        portalAccountClientId: clientAId,
        convertedToClientId: null,
        convertedToApplicationId: null,
      },
    })

    expect(lead).toEqual(expect.objectContaining({
      status: "QUALIFIED",
      portalAccountClientId: clientAId,
      convertedToClientId: null,
      convertedToApplicationId: null,
      conversionRecoveryRequired: false,
    }))
  })

  it("rejects the migrate-before-deploy old staff writer shape", async () => {
    await expect(db.lead.create({
      data: {
        tenantId,
        firstName: "Old Staff",
        lastName: "Writer",
        phone: "+27821000005",
        status: "CONVERTED",
        tags: [],
        convertedToClientId: clientAId,
        // The old writer knows neither the exact application column nor the
        // migration-only recovery marker. Its default false must fail closed.
      },
    })).rejects.toThrow()

    expect(await db.lead.count({
      where: { tenantId, firstName: "Old Staff", lastName: "Writer" },
    })).toBe(0)
  })

  it("accepts an exact converted client/application pair", async () => {
    const lead = await db.lead.create({
      data: {
        tenantId,
        firstName: "Exact",
        lastName: "Conversion",
        phone: "+27821000003",
        status: "CONVERTED",
        tags: [],
        convertedToClientId: clientAId,
        convertedToApplicationId: applicationAId,
      },
    })

    expect(lead.convertedToApplicationId).toBe(applicationAId)
    expect(lead.conversionRecoveryRequired).toBe(false)
  })

  it("rejects an application that belongs to a different converted client", async () => {
    await expect(db.lead.create({
      data: {
        tenantId,
        firstName: "Mismatched",
        lastName: "Conversion",
        phone: "+27821000004",
        status: "CONVERTED",
        tags: [],
        convertedToClientId: clientBId,
        convertedToApplicationId: applicationAId,
      },
    })).rejects.toThrow()

    expect(await db.lead.count({
      where: { tenantId, firstName: "Mismatched", lastName: "Conversion" },
    })).toBe(0)
  })
})
