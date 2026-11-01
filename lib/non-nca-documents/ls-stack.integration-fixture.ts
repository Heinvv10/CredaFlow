/**
 * A tenant, its staff, one product and borrowers with approval-grade evidence, on a throwaway database whose
 * instance is Lesotho (or South Africa): the setup the decide, document and disbursement integration suites share
 * (decide-key-facts.integration.test.ts, ls-end-to-end.integration.test.ts). Everything is synthetic. Not a test file.
 *
 * A borrower has the four core KYC documents verified (origination grade; uploaded before the credit checks'
 * statement window so no reader runs), a verified bank statement for the bank account on the client record, and an
 * UNDER_REVIEW application with intact submission evidence. `nca: true` adds the South African evidence a ZA lender needs
 * (credit-life no-offer disclosure, declaration, reckless-lending assessment, a current bureau check).
 */
import { createHash, randomBytes, randomInt, randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { createSubmissionAffordabilitySnapshot, withAffordabilitySnapshot } from "@/lib/affordability/snapshot"
import { bureauSubjectFingerprint } from "@/lib/compliance/bureau-subject"
import { recomputeApplicationFlags } from "@/lib/credit-checks/recompute"
import { CREDIT_LIFE_NO_OFFER_DISCLOSURE_VERSION } from "@/lib/insurance/credit-life-election"
import { createCreditLifeNoOfferDisclosureSha256 } from "@/lib/insurance/credit-life-election.server"
import { syntheticSaIdNumber } from "@/lib/asset-finance/synthetic-sa-id.integration-fixture"
import { runWithTenant } from "@/lib/tenant-scope"

export type StackJurisdiction = "LS" | "ZA"

export interface Stack {
  jurisdiction: StackJurisdiction
  tenant: string
  /** The officer who captures, approves and signs the lender's side. */
  officer: string
  /** A second officer: the one who pays out (segregation of duties). */
  disburser: string
  /** The senior who attests in-person KYC (the lender's default minimum role for it). */
  senior: string
  product: string
}

/** A R5,000 30-day micro loan: the shape every decide fixture uses (short-term credit, so the NCA cap is the flat 5% a month). */
export const PRODUCT = {
  productType: "MICRO" as const, interestRatePm: 0.05, interestModel: "DAILY_ACCRUAL" as const,
  initiationFeeModel: "FLAT_PCT" as const, initiationFeePct: 0, initiationFeeMax: 0, monthlyServiceFee: 6_900,
}
export const TERMS = { appliedAmount: 500_000, appliedTermDays: 30 }
const EXPENSES = { housing: 400_000, transport: 150_000, food: 150_000, insurance: 50_000, medical: 50_000 }
const LONG_AGO = new Date(Date.now() - 2 * 365 * 86_400_000)

export const stackOf = (jurisdiction: StackJurisdiction, t: string): Stack => ({
  jurisdiction, tenant: `stk-${jurisdiction.toLowerCase()}-${t}`, officer: `stk-officer-${t}`, disburser: `stk-disb-${t}`, senior: `stk-senior-${t}`, product: `stk-product-${t}`,
})

export const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex")

/** The tenant, its config, two LOAN_ADMIN officers, an ADMIN and the product. */
export async function seedStack(db: PrismaClient, stack: Stack, opts: { code: string; isDemoLender?: boolean } = { code: "STK" }) {
  await db.tenant.create({ data: { id: stack.tenant, slug: stack.tenant, name: "Stack IT" } })
  // An in-band (Experian Sigma) score floor: the default 450 is uncalibrated and refers every approval.
  // A key-facts approval needs a screening provider (it has no bureau): the simulated one, which a demo stack may use.
  await db.tenantConfig.create({ data: { tenantId: stack.tenant, bureauMinScore: 580, isDemoLender: opts.isDemoLender ?? false, ...(stack.jurisdiction === "LS" ? { screeningProvider: "simulated" } : {}) } })
  for (const [id, name, role] of [[stack.officer, "Synthetic Officer", "LOAN_ADMIN"], [stack.disburser, "Synthetic Disburser", "LOAN_ADMIN"], [stack.senior, "Synthetic Senior", "ADMIN"]] as const) {
    await db.user.create({ data: { id, tenantId: stack.tenant, email: `${id}@test.invalid`, password: "not-a-real-login", name, role, totpEnabled: true, lastTotpCounter: 1 } })
  }
  await db.loanProduct.create({
    data: { id: stack.product, tenantId: stack.tenant, code: `${opts.code}-${stack.product.slice(-8)}`, name: "Stack micro", minAmount: 100_000, maxAmount: 800_000, minTermDays: 1, maxTermDays: 180, ...PRODUCT },
  })
}

export interface BorrowerBytes {
  /** The bank statement's bytes, to register with the test's storage double under `path`. */
  statement: { path: string; bytes: Buffer }
}

/**
 * A borrower and an UNDER_REVIEW application. Returns the statement bytes for the suite to put in its storage double
 * (the payout gate reads the stored file back and hashes it).
 */
export async function seedUnderReview(db: PrismaClient, stack: Stack, id: string, opts: { nca: boolean; documents?: boolean; income?: number; bank?: boolean; bureau?: boolean }): Promise<BorrowerBytes> {
  const ls = stack.jurisdiction === "LS"
  const clientId = `${id}-client`
  const bank = ls
    ? { bankName: "Demo Bank Lesotho", bankAccountNumber: "62000012345", bankBranchCode: "100001", accountType: "CHEQUE" as const }
    : { bankName: "Demo Bank", bankAccountNumber: "62000012345", bankBranchCode: "250655", accountType: "CHEQUE" as const }
  await db.client.create({
    data: {
      id: clientId, tenantId: stack.tenant, reference: `CLI-${id}`,
      idNumber: ls ? `99${String(randomInt(10_000_000)).padStart(7, "0")}` : syntheticSaIdNumber(),
      firstName: "Synthetic", lastName: "Borrower", email: `${id}@test.invalid`, phone: ls ? "+26658000011" : "+27820000000",
      grossMonthlyIncome: 2_200_000, monthlyIncome: opts.income ?? 2_000_000, monthlyExpenses: 800_000,
      ...(opts.bank === false ? {} : bank), expenseBreakdown: { create: EXPENSES },
    },
  })
  const statementBytes = Buffer.from(`%PDF synthetic bank statement ${id}`)
  const statementPath = `/mem/statement-${id}.pdf`
  if (opts.documents !== false) {
    for (const docType of ["ID_COPY", "PROOF_OF_ADDRESS", "PAYSLIP", "BANK_STATEMENT"] as const) {
      const isStatement = docType === "BANK_STATEMENT"
      await db.clientDocument.create({
        data: {
          tenantId: stack.tenant, clientId, docType, fileUrl: `/synthetic/${docType}`, fileName: `${docType}.pdf`, fileSize: 1024, mimeType: "application/pdf",
          contentSha256: isStatement ? sha256(statementBytes) : randomBytes(32).toString("hex"), storagePath: isStatement ? statementPath : undefined,
          extractionStatus: "skipped", verified: true, verifiedAt: LONG_AGO, verifiedById: stack.officer, createdAt: LONG_AGO, uploadedByType: "staff",
          // What the statement reader would have read off the page: the payout gate matches it to the client's bank record.
          ...(isStatement ? { extractionResult: { fields: { accountNumber: bank.bankAccountNumber, bankName: bank.bankName, accountType: "CHEQUE" } } } : {}),
        },
      })
    }
  }
  const client = await db.client.findUniqueOrThrow({ where: { id: clientId }, include: { expenseBreakdown: true } })
  const submittedAt = new Date(Date.now() - 60 * 60_000)
  const submission = createSubmissionAffordabilitySnapshot({
    capturedAt: submittedAt, capturedById: stack.officer, client, applicationDebts: [], clientDebts: [],
    application: { ...TERMS, productId: stack.product, initiationFeePayment: "DEFERRED" }, product: PRODUCT,
  })
  const noOffer = { version: CREDIT_LIFE_NO_OFFER_DISCLOSURE_VERSION, election: "DECLINED" as const, principalCents: TERMS.appliedAmount, termDays: TERMS.appliedTermDays }
  await db.loanApplication.create({
    data: {
      id, tenantId: stack.tenant, reference: `APP-${id}`, clientId, productId: stack.product, ...TERMS, initiationFeePayment: "DEFERRED", status: "UNDER_REVIEW", submittedAt,
      assignedToId: stack.officer, bureauReviewGeneration: opts.nca ? randomUUID() : null, existingDebtObligations: [],
      affordabilityResult: withAffordabilitySnapshot(null, submission) as object,
      ...(opts.nca ? {
        clientAffordabilityDeclaredAt: submittedAt, recklessLendingAssessed: true, recklessLendingAssessedAt: submittedAt, recklessLendingAssessedById: stack.officer,
        creditLifeElection: "DECLINED" as const, creditLifeMonthlyPremiumCents: 0, creditLifeDisclosureVersion: noOffer.version,
        creditLifeDisclosureSha256: createCreditLifeNoOfferDisclosureSha256(noOffer), creditLifeDisclosureAcknowledgedAt: submittedAt, creditLifeDisclosureAcknowledgedBy: clientId,
      } : {}),
    },
  })
  if (opts.nca && opts.bureau !== false) {
    const application = await db.loanApplication.findUniqueOrThrow({ where: { id } })
    await db.creditBureauCheck.create({
      data: {
        tenantId: stack.tenant, clientId, applicationId: id, reviewGeneration: application.bureauReviewGeneration, subjectFingerprint: bureauSubjectFingerprint(client),
        provider: "experian", score: 640, riskGrade: "LOW", adverseInfo: [], declineReasons: [], obligations: { totalMonthly: 0 }, ok: true,
      },
    })
  }
  return { statement: { path: statementPath, bytes: statementBytes } }
}

/** The real recompute raises its findings (no statement or payslip in the window); an officer clears each with a reason. */
export async function clearOpenFlags(db: PrismaClient, stack: Stack, id: string) {
  await runWithTenant(stack.tenant, () => recomputeApplicationFlags(stack.tenant, id, { userId: stack.officer }))
  await db.applicationCheckFlag.updateMany({
    where: { tenantId: stack.tenant, applicationId: id, status: "OPEN" },
    data: { status: "CLEARED", clearedById: stack.officer, clearedAt: new Date(), clearReason: "Synthetic: income verified by other means." },
  })
}

/** A login role that row-level security binds (neither superuser nor BYPASSRLS), and its connection URL on `databaseUrl`'s server. */
export async function createRlsRole(db: PrismaClient, databaseUrl: string, role: string): Promise<string> {
  const password = randomBytes(12).toString("hex")
  await db.$executeRawUnsafe(`CREATE ROLE ${role} LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${password}'`)
  await db.$executeRawUnsafe(`GRANT USAGE ON SCHEMA public TO ${role}`)
  await db.$executeRawUnsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${role}`)
  await db.$executeRawUnsafe(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${role}`)
  const url = new URL(databaseUrl)
  url.username = role
  url.password = password
  url.searchParams.set("connection_limit", "1")
  return url.toString()
}
