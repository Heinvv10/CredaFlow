/**
 * Real-Postgres proof for the open-application race.
 *
 * Run only against a migrated throwaway database:
 *   RUN_DB_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/applications/open-application.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { PrismaClient } from "@prisma/client"
import { isUniqueConstraintViolation, OPEN_APPLICATION_STATUSES } from "./open-application"

const RUN = process.env.RUN_DB_IT === "1"
const suite = RUN ? describe : describe.skip

suite("LoanApplication partial unique index", () => {
  const prisma = new PrismaClient()
  const token = randomUUID().replaceAll("-", "")
  const ids = {
    tenant: `tenant_open_${token}`,
    client: `client_open_${token}`,
    product: `product_open_${token}`,
  }

  beforeAll(async () => {
    await prisma.tenant.create({
      data: { id: ids.tenant, slug: `open-${token}`, name: "Open Application Race Test" },
    })
    await prisma.client.create({
      data: {
        id: ids.client,
        tenantId: ids.tenant,
        reference: `CLI-${token}`,
        idNumber: token.slice(0, 13).replace(/\D/g, "0"),
        firstName: "Synthetic",
        lastName: "Race",
        email: `open-${token}@test.invalid`,
        phone: "+27820000000",
      },
    })
    await prisma.loanProduct.create({
      data: {
        id: ids.product,
        tenantId: ids.tenant,
        code: `OPEN-${token}`,
        name: "Open Application Race Product",
        productType: "PERSONAL",
        minAmount: 10_000,
        maxAmount: 1_000_000,
        minTermDays: 30,
        maxTermDays: 90,
        interestRatePm: 0.03,
        interestModel: "DAILY_ACCRUAL",
      },
    })
  })

  afterAll(async () => {
    await prisma.loanApplication.deleteMany({ where: { tenantId: ids.tenant } })
    await prisma.loanProduct.deleteMany({ where: { tenantId: ids.tenant } })
    await prisma.client.deleteMany({ where: { tenantId: ids.tenant } })
    await prisma.tenant.deleteMany({ where: { id: ids.tenant } })
    await prisma.$disconnect()
  })

  it("allows exactly one of two concurrent submissions for one client/product", async () => {
    const create = (suffix: string) => prisma.loanApplication.create({
      data: {
        tenantId: ids.tenant,
        reference: `APP-${suffix}-${token}`,
        clientId: ids.client,
        productId: ids.product,
        appliedAmount: 100_000,
        appliedTermDays: 30,
        status: "SUBMITTED",
        submittedAt: new Date(),
      },
    })

    const results = await Promise.allSettled([create("A"), create("B")])
    const fulfilled = results.filter((result) => result.status === "fulfilled")
    const rejected = results.filter((result) => result.status === "rejected")

    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect(isUniqueConstraintViolation(rejected[0]?.reason)).toBe(true)
    expect(await prisma.loanApplication.count({
      where: {
        tenantId: ids.tenant,
        clientId: ids.client,
        productId: ids.product,
        status: { in: [...OPEN_APPLICATION_STATUSES] },
      },
    })).toBe(1)
  })

  it("allows a new application after the prior one reaches a terminal state", async () => {
    await prisma.loanApplication.updateMany({
      where: { tenantId: ids.tenant, clientId: ids.client, productId: ids.product },
      data: { status: "DECLINED" },
    })

    await expect(prisma.loanApplication.create({
      data: {
        tenantId: ids.tenant,
        reference: `APP-C-${token}`,
        clientId: ids.client,
        productId: ids.product,
        appliedAmount: 100_000,
        appliedTermDays: 30,
        status: "SUBMITTED",
        submittedAt: new Date(),
      },
    })).resolves.toEqual(expect.objectContaining({ status: "SUBMITTED" }))
  })
})
