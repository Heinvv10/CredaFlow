/**
 * Shared fixture of the approval matrix's real-Postgres suites (approval*.integration.test.ts): a tenant with one staff member per role, a
 * product, and an application builder, run as a role row-level security binds.
 */
import { randomBytes, randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, vi } from "vitest"
import { decideApplication } from "@/app/api/applications/[id]/decide/decide-application"
import { createSubmissionAffordabilitySnapshot, withAffordabilitySnapshot } from "@/lib/affordability/snapshot"
import { syntheticSaIdNumber } from "@/lib/asset-finance/synthetic-sa-id.integration-fixture"
import { bureauSubjectFingerprint } from "@/lib/compliance/bureau-subject"
import { recomputeApplicationFlags } from "@/lib/credit-checks/recompute"
import { CREDIT_LIFE_NO_OFFER_DISCLOSURE_VERSION } from "@/lib/insurance/credit-life-election"
import { createCreditLifeNoOfferDisclosureSha256 } from "@/lib/insurance/credit-life-election.server"
import { approve, createDraft, submit } from "@/lib/maker-checker/service"
import { createAppPrismaClient } from "@/lib/prisma"
import { sastCalendarDate } from "@/lib/date/sast"
import { runWithTenant } from "@/lib/tenant-scope"
import { holder } from "./approval.integration-prisma"
import { MATRIX_KIND } from "./types"

export const RUN = process.env.RUN_APPROVAL_IT === "1"
export const suite = RUN ? describe.sequential : describe.skip
export const t = randomUUID().replaceAll("-", "").slice(0, 12)
const ROLE = `cf_ap_${t.slice(0, 10)}_it`
export const ids = {
  tenant: `approval-${t}`, product: `ap-product-${t}`, branch: `ap-branch-${t}`,
  la1: `ap-la1-${t}`, la2: `ap-la2-${t}`, bm: `ap-bm-${t}`, ad: `ap-ad-${t}`, ad2: `ap-ad2-${t}`, maker: `ap-maker-${t}`, checker: `ap-checker-${t}`, officer: `ap-officer-${t}`,
}
export const db = new PrismaClient()
let appClient: ReturnType<typeof createAppPrismaClient> | undefined
export const app = () => appClient!
const longAgo = new Date(Date.now() - 2 * 365 * 86_400_000)
export const user = (id: string, role: string) => ({ id, email: `${id}@test.invalid`, role: role as never, totpVerified: true })
export const as = { la1: user(ids.la1, "LOAN_ADMIN"), la2: user(ids.la2, "LOAN_ADMIN"), bm: user(ids.bm, "BRANCH_MANAGER"), ad: user(ids.ad, "ADMIN"), ad2: user(ids.ad2, "ADMIN"), maker: user(ids.maker, "ADMIN"), checker: user(ids.checker, "SUPER_ADMIN") }
export const TODAY = sastCalendarDate(new Date())
export const inTenant = <T,>(fn: () => Promise<T>) => runWithTenant(ids.tenant, async () => await fn())

export const MATRIX = {
  name: "Integration matrix", enabled: true, effectiveFrom: "2026-01-01", defaultRequiredLevels: 1,
  levels: [
    { level: 1, name: "Loan admin", role: "LOAN_ADMIN", slaHours: 24, committee: false },
    { level: 2, name: "Branch manager", role: "BRANCH_MANAGER", slaHours: 24, committee: false },
    { level: 3, name: "Credit committee", role: "ADMIN", slaHours: 48, committee: true },
  ],
  rules: [
    { id: "mid", name: "Mid-size loans", when: { amountMinCents: 400_000 }, requiredLevels: 2 },
    { id: "big", name: "Large loans", when: { amountMinCents: 700_000 }, requiredLevels: 3 },
  ],
}

/** Role grants rewrite shared catalog rows, which Postgres refuses while another suite's grants run (the files may share a database). */
async function ddl(text: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await db.$executeRawUnsafe(text)
      return
    } catch (error) {
      if (attempt >= 20 || !String(error).includes("tuple concurrently updated")) throw error
      await new Promise((resolve) => setTimeout(resolve, 100 + attempt * 50))
    }
  }
}

async function createAppRole(): Promise<string> {
  const password = randomBytes(12).toString("hex")
  const exists = await db.$queryRaw<unknown[]>`SELECT 1 FROM pg_roles WHERE rolname = ${ROLE}`
  if (exists.length === 0) await ddl(`CREATE ROLE ${ROLE} LOGIN NOSUPERUSER NOBYPASSRLS`)
  await ddl(`ALTER ROLE ${ROLE} LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${password}'`)
  await ddl(`GRANT USAGE ON SCHEMA public TO ${ROLE}`)
  await ddl(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${ROLE}`)
  await ddl(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${ROLE}`)
  return password
}
function roleUrl(password: string): string {
  const url = new URL(process.env.DATABASE_URL ?? "")
  url.username = ROLE
  url.password = password
  url.searchParams.set("connection_limit", "1")
  return url.toString()
}

/** A borrower with verified KYC and an UNDER_REVIEW application with intact evidence and a current bureau check (the decide route's fixture). */
export async function underReview(id: string, opts: { amount: number; inputStaff?: string[] }) {
  const terms = { appliedAmount: opts.amount, appliedTermDays: 180 }
  const clientId = `${id}-client`
  await db.client.create({
    data: {
      id: clientId, tenantId: ids.tenant, reference: `CLI-${id}`, idNumber: syntheticSaIdNumber(), firstName: "Synthetic", lastName: "Borrower",
      email: `${id}@test.invalid`, phone: "+27820000000", grossMonthlyIncome: 6_000_000, monthlyIncome: 5_500_000, monthlyExpenses: 3_000_000,
      dateOfBirth: new Date("1988-03-02T00:00:00Z"), employmentStatus: "EMPLOYED",
      expenseBreakdown: { create: { housing: 1_200_000, transport: 500_000, food: 600_000, insurance: 200_000, medical: 200_000, other: 300_000 } },
    },
  })
  for (const docType of ["ID_COPY", "PROOF_OF_ADDRESS", "PAYSLIP", "BANK_STATEMENT"] as const) {
    await db.clientDocument.create({
      data: {
        tenantId: ids.tenant, clientId, docType, fileUrl: `/synthetic/${docType}`, fileName: `${docType}.pdf`, fileSize: 1024, mimeType: "application/pdf",
        contentSha256: randomBytes(32).toString("hex"), extractionStatus: "skipped", verified: true, verifiedAt: longAgo, verifiedById: ids.officer, createdAt: longAgo, uploadedByType: "staff",
      },
    })
  }
  const client = await db.client.findUniqueOrThrow({ where: { id: clientId }, include: { expenseBreakdown: true } })
  const submittedAt = new Date(Date.now() - 60 * 60_000)
  const product = { productType: "MICRO" as const, interestRatePm: 0.05, interestModel: "DAILY_ACCRUAL" as const, initiationFeeModel: "FLAT_PCT" as const, initiationFeePct: 0, initiationFeeMax: 0, monthlyServiceFee: 6_900 }
  const submission = createSubmissionAffordabilitySnapshot({
    capturedAt: submittedAt, capturedById: ids.officer, client, applicationDebts: [], clientDebts: [],
    application: { ...terms, productId: ids.product, initiationFeePayment: "DEFERRED" }, product,
  })
  const noOffer = { version: CREDIT_LIFE_NO_OFFER_DISCLOSURE_VERSION, election: "DECLINED" as const, principalCents: terms.appliedAmount, termDays: terms.appliedTermDays }
  await db.loanApplication.create({
    data: {
      id, tenantId: ids.tenant, reference: `APP-${id}`, clientId, productId: ids.product, branchId: ids.branch, ...terms,
      initiationFeePayment: "DEFERRED", status: "UNDER_REVIEW", submittedAt, assignedToId: ids.officer, bureauReviewGeneration: randomUUID(), existingDebtObligations: [],
      affordabilityResult: withAffordabilitySnapshot(null, submission) as object, clientAffordabilityDeclaredAt: submittedAt,
      recklessLendingAssessed: true, recklessLendingAssessedAt: submittedAt, recklessLendingAssessedById: ids.officer,
      creditLifeElection: "DECLINED", creditLifeMonthlyPremiumCents: 0, creditLifeDisclosureVersion: noOffer.version,
      creditLifeDisclosureSha256: createCreditLifeNoOfferDisclosureSha256(noOffer), creditLifeDisclosureAcknowledgedAt: submittedAt, creditLifeDisclosureAcknowledgedBy: clientId,
      inputStaffIds: opts.inputStaff ?? [],
    },
  })
  const application = await db.loanApplication.findUniqueOrThrow({ where: { id } })
  await db.creditBureauCheck.create({
    data: {
      tenantId: ids.tenant, clientId, applicationId: id, reviewGeneration: application.bureauReviewGeneration, subjectFingerprint: bureauSubjectFingerprint(client),
      provider: "experian", score: 640, riskGrade: "LOW", adverseInfo: [], declineReasons: [], obligations: { totalMonthly: 0 }, ok: true,
    },
  })
  await runWithTenant(ids.tenant, () => recomputeApplicationFlags(ids.tenant, id, { userId: ids.officer }))
  await db.applicationCheckFlag.updateMany({
    where: { tenantId: ids.tenant, applicationId: id, status: "OPEN" },
    data: { status: "CLEARED", clearedById: ids.officer, clearedAt: new Date(), clearReason: "Synthetic: income verified by other means." },
  })
}

/** An approval attempt through the real decide path, as a person. */
export async function approveAs(who: keyof typeof as, applicationId: string, note = "Approved at my level") {
  const form = new FormData()
  form.set("action", "approve")
  form.set("repaymentMethod", "EFT")
  form.set("reason", note)
  const res = await inTenant(() => decideApplication({ tenant: { id: ids.tenant }, user: as[who], id: applicationId, formData: form }))
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}
export const statusOf = async (id: string) => (await db.loanApplication.findUniqueOrThrow({ where: { id } })).status
export const caseOf = (applicationId: string) => db.approvalCase.findFirstOrThrow({ where: { tenantId: ids.tenant, applicationId }, orderBy: { createdAt: "desc" } })
export const stepsOf = (applicationId: string) => db.approvalStep.findMany({ where: { tenantId: ids.tenant, applicationId }, orderBy: { level: "asc" } })
export async function refusal(promise: Promise<unknown>): Promise<string> {
  try { await promise } catch (error) { return String(error) }
  throw new Error("expected the database to refuse")
}
export const sql = (text: string) => db.$executeRawUnsafe(text)

export async function approveMatrix(payload: object, by: "checker" = "checker") {
  const draft = await createDraft({ tenantId: ids.tenant, actor: as.maker, kind: MATRIX_KIND, title: "Matrix", payload })
  await submit({ tenantId: ids.tenant, actor: as.maker, id: draft.id })
  await approve({ tenantId: ids.tenant, actor: as[by], id: draft.id })
  return draft.id
}

/** Registers the suite's setup and teardown; call it inside the suite's describe. */
export function registerApprovalFixture() {
  beforeAll(async () => {
    await db.tenant.create({ data: { id: ids.tenant, slug: ids.tenant, name: "Approval IT" } })
    await db.tenantConfig.create({ data: { tenantId: ids.tenant, bureauMinScore: 580 } })
    const roles: Array<[string, string]> = [[ids.officer, "CREDIT_OFFICER"], [ids.la1, "LOAN_ADMIN"], [ids.la2, "LOAN_ADMIN"], [ids.bm, "BRANCH_MANAGER"], [ids.ad, "ADMIN"], [ids.ad2, "ADMIN"], [ids.maker, "ADMIN"], [ids.checker, "SUPER_ADMIN"]]
    for (const [id, role] of roles) {
      await db.user.create({ data: { id, tenantId: ids.tenant, email: `${id}@test.invalid`, password: "not-a-real-login", name: id, role: role as never, createdAt: new Date(Date.now() - 90 * 86_400_000) } })
    }
    await db.branch.create({ data: { id: ids.branch, tenantId: ids.tenant, name: "Maseru", code: `B-${t}` } as never })
    await db.loanProduct.create({
      data: {
        id: ids.product, tenantId: ids.tenant, code: `AP-${t}`, name: "Approval micro", minAmount: 100_000, maxAmount: 3_000_000, minTermDays: 1, maxTermDays: 180,
        productType: "MICRO", interestRatePm: 0.05, interestModel: "DAILY_ACCRUAL", initiationFeeModel: "FLAT_PCT", initiationFeePct: 0, initiationFeeMax: 0, monthlyServiceFee: 6_900,
      },
    })
    vi.stubEnv("TENANT_RLS", "on")
    appClient = createAppPrismaClient(roleUrl(await createAppRole()))
    holder.app = appClient
  }, 120_000)

  afterAll(async () => {
    vi.unstubAllEnvs()
    holder.app = null
    await appClient?.$disconnect()
    const tenantId = ids.tenant
    await db.$transaction([
      db.$executeRawUnsafe("SET LOCAL session_replication_role = replica"),
      db.notification.deleteMany({ where: { tenantId } }),
      db.creditCommitteeDecision.deleteMany({ where: { tenantId } }),
      db.approvalEscalation.deleteMany({ where: { tenantId } }),
      db.approvalStep.deleteMany({ where: { tenantId } }),
      db.approvalCase.deleteMany({ where: { tenantId } }),
      db.approvalDelegation.deleteMany({ where: { tenantId } }),
      db.approvalMatrixVersion.deleteMany({ where: { tenantId } }),
      db.creditDecisionRecord.deleteMany({ where: { tenantId } }),
      db.auditLog.deleteMany({ where: { tenantId } }),
      db.webhookEvent.deleteMany({ where: { tenantId } }),
      db.applicationCheckFlag.deleteMany({ where: { tenantId } }),
      db.creditBureauCheck.deleteMany({ where: { tenantId } }),
      db.loanApplication.deleteMany({ where: { tenantId } }),
      db.clientDocument.deleteMany({ where: { tenantId } }),
      db.clientExpenseBreakdown.deleteMany({ where: { client: { tenantId } } }),
      db.client.deleteMany({ where: { tenantId } }),
      db.changeRequest.deleteMany({ where: { tenantId } }),
      db.loanProduct.deleteMany({ where: { tenantId } }),
      db.branch.deleteMany({ where: { tenantId } }),
      db.user.deleteMany({ where: { tenantId } }),
      db.tenantConfig.deleteMany({ where: { tenantId } }),
      db.tenant.deleteMany({ where: { id: tenantId } }),
    ])
    if ((await db.$queryRaw<unknown[]>`SELECT 1 FROM pg_roles WHERE rolname = ${ROLE}`).length > 0) {
      await ddl(`DROP OWNED BY ${ROLE}`)
      await ddl(`DROP ROLE IF EXISTS ${ROLE}`)
    }
    await db.$disconnect()
  }, 60_000)
}
