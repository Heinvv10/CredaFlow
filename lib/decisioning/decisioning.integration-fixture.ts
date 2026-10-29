import { randomUUID } from "node:crypto"
import type { PrismaClient } from "@prisma/client"
import { VALID_LENDER_COLUMNS } from "@/lib/config/__fixtures__/lender-identity"

// Shared real-Postgres fixture for the maker-checker and decisioning
// integration suites: one synthetic lender with the staff a four-eyes flow
// needs, a product, and applications under review.
export interface Lender {
  tenantId: string
  productId: string
  makerId: string
  checkerId: string
  delegateId: string
  officerId: string
}

const actor = (id: string, role: string) => ({ id, email: `${id}@test.invalid`, role })
export const asMaker = (l: Lender) => actor(l.makerId, "ADMIN")
export const asChecker = (l: Lender) => actor(l.checkerId, "ADMIN")
export const asOfficer = (l: Lender) => actor(l.officerId, "CREDIT_OFFICER")

export async function createLender(db: PrismaClient): Promise<Lender> {
  const t = randomUUID().replaceAll("-", "").slice(0, 14)
  const tenantId = `t_dec_${t}`
  await db.tenant.create({ data: { id: tenantId, slug: `dec-${t}`, name: "Decisioning IT" } })
  await db.tenantConfig.create({ data: { ...VALID_LENDER_COLUMNS, tenantId } })
  const users = {
    makerId: `u_mk_${t}`, checkerId: `u_ck_${t}`, delegateId: `u_dg_${t}`, officerId: `u_of_${t}`,
  }
  const roles = { makerId: "ADMIN", checkerId: "ADMIN", delegateId: "LOAN_ADMIN", officerId: "CREDIT_OFFICER" } as const
  for (const key of Object.keys(users) as (keyof typeof users)[]) {
    await db.user.create({ data: { id: users[key], tenantId, email: `${users[key]}@test.invalid`, password: "x", role: roles[key] } })
  }
  const product = await db.loanProduct.create({
    data: {
      tenantId, code: "MICRO", name: "Micro", productType: "MICRO", minAmount: 1, maxAmount: 10_000_000,
      minTermDays: 1, maxTermDays: 365, interestRatePm: 0.05, interestModel: "FLAT", monthlyServiceFee: 6_900,
    },
  })
  return { tenantId, productId: product.id, ...users }
}

export async function createApplication(db: PrismaClient, lender: Lender, over: { amount?: number; termDays?: number; status?: "UNDER_REVIEW" | "SUBMITTED" } = {}) {
  const n = randomUUID().replaceAll("-", "").slice(0, 12)
  const client = await db.client.create({
    data: {
      tenantId: lender.tenantId, idNumber: `91${n.slice(0, 11)}`, firstName: "Rule", lastName: "Test", email: `${n}@client.invalid`, phone: "0820000001",
      dateOfBirth: new Date("1990-05-01T00:00:00Z"), employmentStatus: "EMPLOYED", incomeSourceType: "SALARY",
      employmentStartDate: new Date("2020-01-01T00:00:00Z"), monthlyIncome: 2_000_000, monthlyExpenses: 800_000,
    },
  })
  const application = await db.loanApplication.create({
    data: {
      tenantId: lender.tenantId, reference: `APP-${n}`, clientId: client.id, productId: lender.productId,
      appliedAmount: over.amount ?? 300_000, appliedTermDays: over.termDays ?? 90, status: over.status ?? "UNDER_REVIEW",
      submittedAt: new Date("2026-10-01T08:00:00Z"),
    },
  })
  return { applicationId: application.id, clientId: client.id }
}
