/**
 * Fixtures for the RUN_TENANT_ISOLATION_IT suites: two lenders under one
 * test operator, each with a client holding the SAME ID number and email,
 * and the borrower-core rows hanging off it. All values are synthetic.
 *
 * Rows are written through a plain PrismaClient on DATABASE_URL (a superuser
 * in CI and locally), which neither the tenant-scope extension nor RLS binds.
 */
import { randomBytes } from "node:crypto"
import type { PrismaClient } from "@prisma/client"

export type Lender = {
  tenantId: string
  slug: string
  clientId: string
  documentId: string
  applicationId: string
  loanId: string
  adminId: string
}

export type IsolationFixture = {
  token: string
  operatorId: string
  otherOperatorId: string
  operatorUserId: string
  /** Shared by both lenders' clients: borrowers are per lender. */
  idNumber: string
  email: string
  a: Lender
  b: Lender
}

const DAY_MS = 86_400_000

async function lender(db: PrismaClient, f: Omit<IsolationFixture, "a" | "b">, label: string): Promise<Lender> {
  const slug = `iso-it-${label}-${f.token}`
  const tenant = await db.tenant.create({
    data: { slug, name: `Isolation IT ${label}`, status: "ACTIVE", operatorId: f.operatorId },
  })
  const tenantId = tenant.id
  const admin = await db.user.create({
    data: {
      tenantId, email: `admin-${label}-${f.token}@iso-it.invalid`, name: `Admin ${label}`,
      role: "ADMIN", password: "synthetic-not-a-hash",
    },
  })
  const client = await db.client.create({
    data: {
      tenantId, idNumber: f.idNumber, email: f.email, firstName: "Synthetic", lastName: label.toUpperCase(),
      phone: "0820000000", expenseBreakdown: { create: { housing: 100 } },
    },
  })
  const document = await db.clientDocument.create({
    data: { tenantId, clientId: client.id, docType: "ID_COPY", fileName: "id.pdf", fileUrl: `/synthetic/${label}-${f.token}.pdf` },
  })
  const product = await db.loanProduct.create({
    data: {
      tenantId, code: `ISO-${label}-${f.token}`, name: "Synthetic Personal", productType: "PERSONAL",
      minAmount: 1, maxAmount: 10_000_000, minTermDays: 30, maxTermDays: 365, interestRatePm: 0, interestModel: "FLAT",
    },
  })
  const application = await db.loanApplication.create({
    data: {
      tenantId, reference: `ISO-APP-${label}-${f.token}`, clientId: client.id, productId: product.id,
      appliedAmount: 500_000, appliedTermDays: 90,
    },
  })
  const loan = await db.loan.create({
    data: {
      tenantId, reference: `ISO-LN-${label}-${f.token}`, applicationId: application.id, clientId: client.id,
      productId: product.id, principal: 500_000, totalInterest: 0, initiationFee: 0, totalRepayable: 500_000,
      outstandingPrincipal: 500_000, startDate: new Date(Date.now() - 10 * DAY_MS),
      maturityDate: new Date(Date.now() + 80 * DAY_MS), interestRatePm: 0, interestModel: "FLAT", status: "ACTIVE",
    },
  })
  return {
    tenantId, slug, clientId: client.id, documentId: document.id,
    applicationId: application.id, loanId: loan.id, adminId: admin.id,
  }
}

export async function createIsolationFixture(db: PrismaClient): Promise<IsolationFixture> {
  const token = randomBytes(5).toString("hex")
  const operator = await db.operator.create({ data: { slug: `iso-it-op-${token}`, name: "Isolation IT Operator" } })
  const other = await db.operator.create({ data: { slug: `iso-it-other-${token}`, name: "Isolation IT Other Operator" } })
  const operatorUser = await db.user.create({
    data: {
      operatorId: operator.id, email: `support-${token}@iso-it.invalid`, name: "Operator Support",
      role: "OPERATOR_SUPPORT", password: "synthetic-not-a-hash",
    },
  })
  const base = {
    token, operatorId: operator.id, otherOperatorId: other.id, operatorUserId: operatorUser.id,
    idNumber: `99${parseInt(token, 16).toString().padStart(11, "0").slice(-11)}`,
    email: `same-person-${token}@iso-it.invalid`,
  }
  return { ...base, a: await lender(db, base, "a"), b: await lender(db, base, "b") }
}

/**
 * Removes everything the fixture made. Support grants refuse deletion and the
 * borrower rows reference each other, so this runs with triggers off
 * (session_replication_role = replica), as other suites' teardown does.
 */
export async function dropIsolationFixture(db: PrismaClient, f: IsolationFixture | undefined): Promise<void> {
  if (!f) return
  const tenants = [f.a.tenantId, f.b.tenantId]
  const byTenant = [
    "AuditLog", "TenantSupportGrant", "PaymentArrangement", "Loan", "LoanApplication", "LoanProduct", "ClientDocument", "Client", "User",
  ]
  await db.$transaction([
    db.$executeRawUnsafe("SET LOCAL session_replication_role = replica"),
    db.$executeRawUnsafe(
      `DELETE FROM "ClientExpenseBreakdown" WHERE "clientId" IN (SELECT "id" FROM "Client" WHERE "tenantId" = ANY($1))`,
      tenants,
    ),
    ...byTenant.map((t) => db.$executeRawUnsafe(`DELETE FROM "${t}" WHERE "tenantId" = ANY($1)`, tenants)),
    db.$executeRawUnsafe(`DELETE FROM "AuditLog" WHERE "userId" = $1`, f.operatorUserId),
    db.$executeRawUnsafe(`DELETE FROM "User" WHERE "id" = $1`, f.operatorUserId),
    db.$executeRawUnsafe(`DELETE FROM "Tenant" WHERE "id" = ANY($1)`, tenants),
    db.$executeRawUnsafe(`DELETE FROM "Operator" WHERE "id" = ANY($1)`, [f.operatorId, f.otherOperatorId]),
  ])
}
