import { randomUUID } from "node:crypto"
import type { PrismaClient } from "@prisma/client"
import { generateApiKey } from "@/lib/lender-api/keys"
import type { ApiScope } from "@/lib/lender-api/scopes"

// Real-Postgres fixture for lender-api.integration.test.ts: one lender with a
// staff admin, a product, a client (with income, so a draft application
// passes affordability), an application, a loan with a schedule row and a
// payment. All values synthetic.

export interface ApiTenant {
  tenantId: string
  slug: string
  userId: string
  productId: string
  clientId: string
  spareClientId: string
  applicationId: string
  loanId: string
  paymentId: string
  idNumber: string
}

export async function createApiTenant(db: PrismaClient, label: string): Promise<ApiTenant> {
  const t = randomUUID().replaceAll("-", "").slice(0, 14)
  const tenantId = `t_api_${label}_${t}`
  const slug = `api-${label}-${t}`.toLowerCase()
  const userId = `u_api_${label}_${t}`
  await db.tenant.create({ data: { id: tenantId, slug, name: `API IT ${label}` } })
  await db.user.create({ data: { id: userId, tenantId, email: `${userId}@test.invalid`, password: "x", role: "ADMIN" } })
  const product = await db.loanProduct.create({
    data: {
      tenantId, code: `P${t.slice(0, 6)}`, name: "IT Product", productType: "MICRO",
      minAmount: 50_000, maxAmount: 1_000_000, minTermDays: 7, maxTermDays: 60,
      interestRatePm: 0.05, interestModel: "FLAT", monthlyServiceFee: 6_900,
    },
  })
  const client = (suffix: string, idNumber: string) => db.client.create({
    data: {
      id: `c_api_${label}_${suffix}_${t}`, tenantId, idNumber,
      firstName: "Synthetic", lastName: `Client${label}`, email: `${suffix}${t}@client.invalid`, phone: "0820000000",
      monthlyIncome: 3_000_000, monthlyExpenses: 500_000,
    },
  })
  const n = t.replace(/[^0-9]/g, "").padEnd(11, "0").slice(0, 11)
  const idNumber = `90${n}`
  const c = await client("main", idNumber)
  const spare = await client("spare", `91${n}`)
  const app = await db.loanApplication.create({
    data: { tenantId, reference: `APP-IT-${label}-${t}`, clientId: c.id, productId: product.id, appliedAmount: 200_000, appliedTermDays: 31 },
  })
  const loan = await db.loan.create({
    data: {
      tenantId, reference: `LN-IT-${label}-${t}`, applicationId: app.id, clientId: c.id, productId: product.id,
      principal: 200_000, totalInterest: 10_000, initiationFee: 0, totalRepayable: 216_900, outstandingPrincipal: 200_000,
      startDate: new Date("2026-09-01T08:00:00Z"), maturityDate: new Date("2026-10-01T08:00:00Z"),
      interestRatePm: 0.05, interestModel: "FLAT", status: "ACTIVE", monthlyServiceFee: 6_900,
    },
  })
  await db.repaymentSchedule.create({
    data: { tenantId, loanId: loan.id, installmentNo: 1, dueDate: new Date("2026-10-01T08:00:00Z"), principalDue: 200_000, interestDue: 10_000, feesDue: 6_900, totalDue: 216_900 },
  })
  const payment = await db.payment.create({ data: { tenantId, loanId: loan.id, amount: 50_000, reference: `PAY-IT-${t}` } })
  return {
    tenantId, slug, userId, productId: product.id, clientId: c.id, spareClientId: spare.id,
    applicationId: app.id, loanId: loan.id, paymentId: payment.id, idNumber,
  }
}

export async function issueKey(db: PrismaClient, tenant: ApiTenant, scopes: ApiScope[], extra: { expiresAt?: Date } = {}): Promise<{ id: string; key: string }> {
  const g = generateApiKey()
  const row = await db.apiKey.create({
    data: {
      tenantId: tenant.tenantId, name: `IT ${scopes.join(",")}`, prefix: g.prefix, keyHash: g.keyHash, scopes,
      createdById: tenant.userId, expiresAt: extra.expiresAt ?? new Date(Date.now() + 86_400_000),
      ...(extra.expiresAt && extra.expiresAt < new Date() ? { createdAt: new Date(extra.expiresAt.getTime() - 86_400_000) } : {}),
    },
  })
  return { id: row.id, key: g.key }
}

export async function deleteApiTenant(db: PrismaClient, t: ApiTenant): Promise<void> {
  const where = { tenantId: t.tenantId }
  await db.webhookDelivery.deleteMany({ where })
  await db.webhookOutboxFailure.deleteMany({ where })
  await db.webhookEvent.deleteMany({ where })
  await db.webhookEndpoint.deleteMany({ where })
  await db.apiRequestLog.deleteMany({ where })
  await db.apiKey.deleteMany({ where })
  await db.auditLog.deleteMany({ where })
  await db.payment.deleteMany({ where })
  await db.repaymentSchedule.deleteMany({ where })
  await db.loan.deleteMany({ where })
  await db.loanApplication.deleteMany({ where })
  await db.client.deleteMany({ where })
  await db.loanProduct.deleteMany({ where })
  await db.user.deleteMany({ where })
  await db.tenant.deleteMany({ where: { id: t.tenantId } })
}
