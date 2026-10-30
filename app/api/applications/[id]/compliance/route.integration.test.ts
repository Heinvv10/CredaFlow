/**
 * Real-Postgres proof that a failed compliance audit rolls back its application update.
 *
 * Run only against a fully migrated throwaway database:
 *   RUN_DB_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run 'app/api/applications/[id]/compliance/route.integration.test.ts'
 */
import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import { PrismaClient } from "@prisma/client"

const authState = vi.hoisted(() => ({
  tenantId: "",
  userId: "missing-audit-user",
}))

vi.mock("@/lib/auth-guards", () => ({
  requireApiRole: vi.fn().mockImplementation(async () => ({
    error: null,
    user: { id: authState.userId, email: "missing-user@test.invalid" },
  })),
}))
vi.mock("@/lib/tenant", () => ({
  withTenantContext: (_req: NextRequest, callback: (tenant: { id: string }) => unknown) =>
    callback({ id: authState.tenantId }),
}))

import { PATCH } from "./route"
import { purgeAuditRowsForTest } from "@/lib/audit/audit-rows.test-helpers"

const RUN = process.env.RUN_DB_IT === "1"
const suite = RUN ? describe : describe.skip

suite("compliance mutation audit transaction", () => {
  const db = new PrismaClient()
  const token = randomUUID().replaceAll("-", "")
  const ids = {
    tenant: `tenant_compliance_${token}`,
    client: `client_compliance_${token}`,
    product: `product_compliance_${token}`,
    application: `application_compliance_${token}`,
  }

  beforeAll(async () => {
    authState.tenantId = ids.tenant
    authState.userId = `missing_user_${token}`
    await db.tenant.create({
      data: { id: ids.tenant, slug: `compliance-${token}`, name: "Compliance Audit Test" },
    })
    await db.client.create({
      data: {
        id: ids.client,
        tenantId: ids.tenant,
        reference: `CLI-COMP-${token}`,
        idNumber: `COMP-${token}`,
        firstName: "Synthetic",
        lastName: "Compliance",
        email: `compliance-${token}@test.invalid`,
        phone: "+27820000011",
      },
    })
    await db.loanProduct.create({
      data: {
        id: ids.product,
        tenantId: ids.tenant,
        code: `COMP-${token}`,
        name: "Compliance Audit Product",
        productType: "PERSONAL",
        minAmount: 10_000,
        maxAmount: 1_000_000,
        minTermDays: 30,
        maxTermDays: 90,
        interestRatePm: 0.03,
        interestModel: "DAILY_ACCRUAL",
      },
    })
    await db.loanApplication.create({
      data: {
        id: ids.application,
        tenantId: ids.tenant,
        reference: `APP-COMP-${token}`,
        clientId: ids.client,
        productId: ids.product,
        appliedAmount: 100_000,
        appliedTermDays: 30,
        status: "SUBMITTED",
      },
    })
  })

  afterAll(async () => {
    await purgeAuditRowsForTest(db, { tenantId: ids.tenant })
    await db.loanApplication.deleteMany({ where: { tenantId: ids.tenant } })
    await db.loanProduct.deleteMany({ where: { tenantId: ids.tenant } })
    await db.client.deleteMany({ where: { tenantId: ids.tenant } })
    await db.tenant.deleteMany({ where: { id: ids.tenant } })
    await db.$disconnect()
  })

  it("keeps compliance evidence unchanged when the mandatory audit insert violates its user FK", async () => {
    const request = new NextRequest(
      `http://localhost/api/applications/${ids.application}/compliance`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          recklessLendingAssessed: true,
          recklessLendingNote: "Must roll back",
        }),
      },
    )

    const response = await PATCH(request, {
      params: Promise.resolve({ id: ids.application }),
    })

    expect(response.status).toBe(500)
    await expect(db.loanApplication.findUniqueOrThrow({
      where: { id: ids.application },
      select: { recklessLendingAssessed: true, recklessLendingNote: true },
    })).resolves.toEqual({
      recklessLendingAssessed: false,
      recklessLendingNote: null,
    })
    await expect(db.auditLog.count({
      where: { tenantId: ids.tenant, entityId: ids.application },
    })).resolves.toBe(0)
  })
})
