/**
 * Real-Postgres fixtures for the Statement AI suites: a tenant with one staff
 * user per role, a client, an application and a read statement stored as a
 * StatementAnalysis row (no PDF: the suites read persisted rows only).
 * Synthetic values only.
 */
import { randomUUID } from "node:crypto"
import type { UserRole } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { sha256DocumentBytes } from "@/lib/documents/content-integrity"
import type { StatementTransaction } from "@/lib/statement-analysis/types"
import { PARSER_VERSION } from "@/lib/statement-analysis/analyse"

export const FIXTURE_ROLES: UserRole[] = ["SUPER_ADMIN", "ADMIN", "LOAN_ADMIN", "CREDIT_OFFICER", "READONLY"]

export interface AiFixture {
  tenantId: string
  /** Sent as x-tenant-slug: the routes resolve the tenant from it. */
  slug: string
  applicationId: string
  clientId: string
  documentId: string
  analysisId: string
  userIds: Record<string, string>
}

/** Three months of a salaried synthetic client: a test may pass its own rows. */
export function syntheticTransactions(): StatementTransaction[] {
  const rows: StatementTransaction[] = []
  let balance = 500_000
  for (const m of ["2026-07", "2026-08", "2026-09"]) {
    for (const [day, description, amountCents] of [
      ["02", "Card Purchase: SYNTH MART GROCER", -84_550],
      ["05", "DebiCheck Debit: SYNTHLEND FINANCE", -125_000],
      ["12", "Card Purchase: HOLLYWOODBETS", -150_000],
      ["15", "Card Purchase: SYNTH FUEL", -60_000],
      ["25", "Payment Received: SALARY SYNTHCO", 1_845_000],
      ["27", "Payment To: SYNTH RENTALS", -650_000],
    ] as const) {
      balance += amountCents
      rows.push({ date: `${m}-${day}`, description, amountCents, balanceCents: balance, page: 1 })
    }
  }
  return rows
}

export async function createAiFixture(opts: { featureStatementAi: boolean; transactions?: StatementTransaction[]; label?: string }): Promise<AiFixture> {
  const token = `${opts.label ?? "ai"}_${randomUUID().replaceAll("-", "").slice(0, 16)}`
  const tenantId = `tenant_${token}`
  const clientId = `client_${token}`
  const applicationId = `app_${token}`
  const documentId = `doc_${token}`
  const transactions = opts.transactions ?? syntheticTransactions()
  const slug = `ai-${token}`.replaceAll("_", "-")
  await prisma.tenant.create({ data: { id: tenantId, slug, name: "Statement AI test" } })
  await prisma.tenantConfig.create({ data: { tenantId, featureStatementAi: opts.featureStatementAi } })
  const userIds: Record<string, string> = {}
  for (const role of FIXTURE_ROLES) {
    const id = `user_${role.toLowerCase()}_${token}`
    await prisma.user.create({ data: { id, tenantId, email: `${role.toLowerCase()}-${token}@test.invalid`, password: "x", role } })
    userIds[role] = id
  }
  await prisma.client.create({
    data: {
      id: clientId, tenantId, reference: `CLI-${token}`, idNumber: `ID-${token}`, firstName: "Thabo", lastName: "Tester",
      email: `client-${token}@test.invalid`, phone: "+27820000000", monthlyIncome: 1_845_000,
    },
  })
  await prisma.loanProduct.create({
    data: { id: `product_${token}`, tenantId, code: `AI-${token}`, name: "AI product", productType: "PERSONAL", minAmount: 100_000, maxAmount: 1_000_000, minTermDays: 30, maxTermDays: 90, interestRatePm: 0.03, interestModel: "DAILY_ACCRUAL" },
  })
  await prisma.loanApplication.create({
    data: { id: applicationId, tenantId, reference: `APP-${token}`, clientId, productId: `product_${token}`, appliedAmount: 500_000, appliedTermDays: 30, status: "UNDER_REVIEW", submittedAt: new Date("2026-10-05T08:00:00Z") },
  })
  const bytes = Buffer.from(`synthetic statement ${token}`)
  const sha = sha256DocumentBytes(bytes)
  await prisma.clientDocument.create({
    data: {
      id: documentId, tenantId, clientId, docType: "BANK_STATEMENT", fileUrl: "", fileName: "statement.pdf",
      mimeType: "application/pdf", storagePath: `/nonexistent/${token}.pdf`, contentSha256: sha, extractionStatus: "done",
      createdAt: new Date("2026-10-02T08:00:00Z"),
    },
  })
  const opening = 500_000
  const closing = opening + transactions.reduce((s, t) => s + t.amountCents, 0)
  const analysis = await prisma.statementAnalysis.create({
    data: {
      tenantId, clientDocumentId: documentId, contentSha256: sha, parserVersion: PARSER_VERSION, method: "TEXT", status: "READ",
      bank: "CAPITEC", accountHolderName: "T TESTER", accountNumberLast4: "0001",
      periodStart: new Date(`${transactions[0]?.date ?? "2026-07-01"}T00:00:00Z`),
      periodEnd: new Date(`${transactions[transactions.length - 1]?.date ?? "2026-09-30"}T00:00:00Z`),
      openingBalanceCents: opening, closingBalanceCents: closing,
      transactions: transactions as unknown as object, balanceCheck: "PASS", balanceDiffCents: 0,
      authenticity: { producer: "OpenPDF 2.0.2", creator: "", createdAt: null, modifiedAt: null, incrementalUpdates: 0, signals: [] },
    },
  })
  return { tenantId, slug, applicationId, clientId, documentId, analysisId: analysis.id, userIds }
}

export async function dropAiFixture(f: AiFixture): Promise<void> {
  const where = { tenantId: f.tenantId }
  await prisma.statementAiOutput.deleteMany({ where })
  await prisma.statementAiUsage.deleteMany({ where })
  await prisma.documentAccessLog.deleteMany({ where: { documentId: f.documentId } })
  await prisma.auditLog.deleteMany({ where })
  await prisma.$transaction([
    prisma.$executeRawUnsafe(`ALTER TABLE "ApplicationCheckFlag" DISABLE TRIGGER "ApplicationCheckFlag_guard_record"`),
    prisma.$executeRawUnsafe(`DELETE FROM "ApplicationCheckFlag" WHERE "tenantId" = '${f.tenantId}'`),
    prisma.$executeRawUnsafe(`ALTER TABLE "ApplicationCheckFlag" ENABLE TRIGGER "ApplicationCheckFlag_guard_record"`),
  ])
  await prisma.statementAnalysis.deleteMany({ where })
  await prisma.clientDocument.deleteMany({ where })
  await prisma.loanApplication.deleteMany({ where })
  await prisma.loanProduct.deleteMany({ where })
  await prisma.client.deleteMany({ where })
  await prisma.user.deleteMany({ where })
  await prisma.tenantConfig.deleteMany({ where })
  await prisma.tenant.delete({ where: { id: f.tenantId } })
}

/** A staff session for `role` in the fixture's tenant, as lib/auth returns it. */
export function sessionFor(f: AiFixture, role: UserRole) {
  return { user: { id: f.userIds[role], email: `${role.toLowerCase()}@test.invalid`, name: null, role, tenantId: f.tenantId, totpVerified: true, tokenVersion: 0 } }
}
