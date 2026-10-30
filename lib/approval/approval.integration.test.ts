/**
 * Real-Postgres proof of the approval matrix (migration 20261030100000_approval_matrix), through the real staff approval path and
 * under a role row-level security binds: the matrix arrives only by maker-checker; a multi-level application is approved level by
 * level by different people, by role or by delegation; the maker never approves; the engine cannot approve what needs staff; the
 * credit committee's decision gates its level; overdue approvals escalate; and the database refuses an APPROVED application whose
 * chain is incomplete, a step out of order, from the maker or from the system account.
 *
 *   RUN_APPROVAL_IT=1 DATABASE_URL=postgresql://... npx vitest run lib/approval/approval.integration.test.ts
 */
import { randomBytes, randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

const holder = vi.hoisted(() => ({ app: null as object | null }))

vi.mock("@/lib/prisma", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/prisma")>()
  const prisma = new Proxy({}, {
    get(_target, key) {
      if (!holder.app) throw new Error("the RLS-bound app client is created in beforeAll")
      const value: unknown = Reflect.get(holder.app, key)
      return typeof value === "function" ? value.bind(holder.app) : value
    },
  })
  return { ...actual, prisma }
})
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => null) }))
vi.mock("@/lib/notifications", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/notifications")>()), triggerNotification: vi.fn(async () => undefined) }))

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
import { recordCommitteeDecision } from "./committee"
import { grantDelegation, revokeDelegation } from "./delegations"
import { escalateOverdueApprovals } from "./escalation"
import { gateApproval, openApprovalCaseSafely } from "./chain"
import { loadApprovalProgress } from "./progress"
import { MATRIX_KIND } from "./types"

const RUN = process.env.RUN_APPROVAL_IT === "1"
const suite = RUN ? describe.sequential : describe.skip
const ROLE = "cf_approval_it"
const t = randomUUID().replaceAll("-", "").slice(0, 12)
const ids = {
  tenant: `approval-${t}`, product: `ap-product-${t}`, branch: `ap-branch-${t}`,
  la1: `ap-la1-${t}`, la2: `ap-la2-${t}`, bm: `ap-bm-${t}`, ad: `ap-ad-${t}`, ad2: `ap-ad2-${t}`, maker: `ap-maker-${t}`, checker: `ap-checker-${t}`, officer: `ap-officer-${t}`,
}
const db = new PrismaClient()
let appClient: ReturnType<typeof createAppPrismaClient> | undefined
const longAgo = new Date(Date.now() - 2 * 365 * 86_400_000)
const user = (id: string, role: string) => ({ id, email: `${id}@test.invalid`, role: role as never, totpVerified: true })
const as = { la1: user(ids.la1, "LOAN_ADMIN"), la2: user(ids.la2, "LOAN_ADMIN"), bm: user(ids.bm, "BRANCH_MANAGER"), ad: user(ids.ad, "ADMIN"), ad2: user(ids.ad2, "ADMIN"), maker: user(ids.maker, "ADMIN"), checker: user(ids.checker, "SUPER_ADMIN") }
const TODAY = sastCalendarDate(new Date())
const inTenant = <T,>(fn: () => Promise<T>) => runWithTenant(ids.tenant, async () => await fn())

const MATRIX = {
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

async function createAppRole(): Promise<string> {
  const password = randomBytes(12).toString("hex")
  const exists = await db.$queryRaw<unknown[]>`SELECT 1 FROM pg_roles WHERE rolname = ${ROLE}`
  if (exists.length === 0) await db.$executeRawUnsafe(`CREATE ROLE ${ROLE} LOGIN NOSUPERUSER NOBYPASSRLS`)
  await db.$executeRawUnsafe(`ALTER ROLE ${ROLE} LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${password}'`)
  await db.$executeRawUnsafe(`GRANT USAGE ON SCHEMA public TO ${ROLE}`)
  await db.$executeRawUnsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${ROLE}`)
  await db.$executeRawUnsafe(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${ROLE}`)
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
async function underReview(id: string, opts: { amount: number; inputStaff?: string[] }) {
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
async function approveAs(who: keyof typeof as, applicationId: string, note = "Approved at my level") {
  const form = new FormData()
  form.set("action", "approve")
  form.set("repaymentMethod", "EFT")
  form.set("reason", note)
  const res = await inTenant(() => decideApplication({ tenant: { id: ids.tenant }, user: as[who], id: applicationId, formData: form }))
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}
const statusOf = async (id: string) => (await db.loanApplication.findUniqueOrThrow({ where: { id } })).status
const caseOf = (applicationId: string) => db.approvalCase.findFirstOrThrow({ where: { tenantId: ids.tenant, applicationId }, orderBy: { createdAt: "desc" } })
const stepsOf = (applicationId: string) => db.approvalStep.findMany({ where: { tenantId: ids.tenant, applicationId }, orderBy: { level: "asc" } })
async function refusal(promise: Promise<unknown>): Promise<string> {
  try { await promise } catch (error) { return String(error) }
  throw new Error("expected the database to refuse")
}
const sql = (text: string) => db.$executeRawUnsafe(text)

async function approveMatrix(payload: object, by: "checker" = "checker") {
  const draft = await createDraft({ tenantId: ids.tenant, actor: as.maker, kind: MATRIX_KIND, title: "Matrix", payload })
  await submit({ tenantId: ids.tenant, actor: as.maker, id: draft.id })
  await approve({ tenantId: ids.tenant, actor: as[by], id: draft.id })
  return draft.id
}

suite("approval matrix (real Postgres, row-level security)", () => {
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
      await db.$executeRawUnsafe(`DROP OWNED BY ${ROLE}`)
      await db.$executeRawUnsafe(`DROP ROLE IF EXISTS ${ROLE}`)
    }
    await db.$disconnect()
  }, 60_000)

  it("runs as a role row-level security binds (otherwise it proves nothing)", async () => {
    const [me] = await appClient!.$queryRaw<{ su: boolean; bypass: boolean }[]>`SELECT rolsuper AS su, rolbypassrls AS bypass FROM pg_roles WHERE rolname = current_user`
    expect(me).toEqual({ su: false, bypass: false })
  })

  it("with no matrix, an approval is the single-approver flow it always was (no case, no step)", async () => {
    await underReview("ap-nomatrix", { amount: 300_000 })
    const res = await approveAs("la1", "ap-nomatrix")
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(await statusOf("ap-nomatrix")).toBe("APPROVED")
    expect(await db.approvalCase.count({ where: { tenantId: ids.tenant, applicationId: "ap-nomatrix" } })).toBe(0)
  })

  it("the matrix arrives only through maker-checker, holds exactly what was approved, and never changes", async () => {
    const requestId = await approveMatrix(MATRIX)
    const version = await db.approvalMatrixVersion.findFirstOrThrow({ where: { tenantId: ids.tenant } })
    expect(version).toMatchObject({ version: 1, name: "Integration matrix", enabled: true, defaultRequiredLevels: 1, changeRequestId: requestId })
    const insert = (over: string, request = requestId) => sql(`INSERT INTO "ApprovalMatrixVersion" ("id","tenantId","version","name","enabled","effectiveFrom","levels","rules","defaultRequiredLevels","changeRequestId") VALUES ('v-${randomUUID()}','${ids.tenant}',${over})`.replace("REQ", request))
    expect(await refusal(insert(`9,'x',true,'2026-01-01','[]'::jsonb,'[]'::jsonb,1,'no-such-request'`))).toMatch(/jsonb|created only by an approved/i)
    const levelsJson = JSON.stringify(MATRIX.levels).replaceAll("'", "''")
    expect(await refusal(insert(`9,'Integration matrix',true,'2026-01-01','${levelsJson}'::jsonb,'[]'::jsonb,1,'no-such-request'`))).toContain("created only by an approved APPROVAL_MATRIX change request")
    expect(await refusal(insert(`9,'Integration matrix',true,'2026-01-01','${levelsJson}'::jsonb,'[]'::jsonb,0,'${requestId}'`))).toContain("must match the approved change request")
    const rulesJson = JSON.stringify(MATRIX.rules).replaceAll("'", "''")
    const good = (over: Record<number, string>) => ["9", "'Integration matrix'", "true", "'2026-01-01'", `'${levelsJson}'::jsonb`, `'${rulesJson}'::jsonb`, "1", `'${requestId}'`].map((v, i) => over[i] ?? v).join(",")
    // Each approved column is pinned on its own: the name, the switch, the levels, the rules and the default.
    const overs: Array<Record<number, string>> = [{ 1: "'Renamed'" }, { 2: "false" }, { 4: "'[]'::jsonb" }, { 5: "'[]'::jsonb" }, { 6: "2" }]
    for (const over of overs) {
      expect(await refusal(insert(good(over)))).toContain("must match the approved change request")
    }
    expect(await refusal(sql(`UPDATE "ApprovalMatrixVersion" SET "name" = 'Edited' WHERE "id" = '${version.id}'`))).toContain("never changes or goes away")
    expect(await refusal(sql(`DELETE FROM "ApprovalMatrixVersion" WHERE "id" = '${version.id}'`))).toContain("never changes or goes away")
  })

  it("a matrix that loosens (a rule needing no approval, or off) needs a SUPER_ADMIN to approve", async () => {
    for (const over of [{ defaultRequiredLevels: 0 }, { enabled: false }, { rules: [{ id: "auto", name: "Small", when: { amountMaxCents: 100_000 }, requiredLevels: 0 }] }]) {
      const draft = await createDraft({ tenantId: ids.tenant, actor: as.maker, kind: MATRIX_KIND, title: "Loosen", payload: { ...MATRIX, ...over } })
      await submit({ tenantId: ids.tenant, actor: as.maker, id: draft.id })
      await expect(approve({ tenantId: ids.tenant, actor: as.ad, id: draft.id })).rejects.toMatchObject({ code: "FORBIDDEN" })
    }
  })

  it("one level required: a loan admin's approval is the whole chain, and the case ends APPROVED with the step on record", async () => {
    await underReview("ap-small", { amount: 300_000 })
    const res = await approveAs("la1", "ap-small")
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(await statusOf("ap-small")).toBe("APPROVED")
    expect(await caseOf("ap-small")).toMatchObject({ status: "APPROVED", requiredLevels: 1, matchedRuleIds: [] })
    expect(await stepsOf("ap-small")).toMatchObject([{ level: 1, approverId: ids.la1, via: "ROLE" }])
  })

  it("two levels: level 1 is recorded and leaves it under review; the same person cannot do level 2, nor can a role below it; the branch manager completes it", async () => {
    await underReview("ap-mid", { amount: 500_000 })
    const first = await approveAs("la1", "ap-mid")
    expect(first).toMatchObject({ status: 200, body: { approvalRecorded: true, level: 1, requiredLevels: 2, nextLevel: 2, status: "UNDER_REVIEW" } })
    expect(await statusOf("ap-mid")).toBe("UNDER_REVIEW")
    expect(await approveAs("la1", "ap-mid")).toMatchObject({ status: 409, body: { approvalMatrix: "ALREADY_APPROVED" } })
    expect(await approveAs("la2", "ap-mid")).toMatchObject({ status: 403, body: { approvalMatrix: "LEVEL_AUTHORITY_REQUIRED" } })
    expect(await statusOf("ap-mid")).toBe("UNDER_REVIEW")
    const last = await approveAs("bm", "ap-mid")
    expect(last.status, JSON.stringify(last.body)).toBe(200)
    expect(await statusOf("ap-mid")).toBe("APPROVED")
    expect(await caseOf("ap-mid")).toMatchObject({ status: "APPROVED", requiredLevels: 2, matchedRuleIds: ["mid"] })
    expect((await stepsOf("ap-mid")).map((s) => [s.level, s.approverId])).toEqual([[1, ids.la1], [2, ids.bm]])
  })

  it("progress shows each level, who approved it, and whether the viewer may approve next", async () => {
    const progress = await loadApprovalProgress({ tenantId: ids.tenant, applicationId: "ap-mid", viewer: { id: ids.la2, role: "LOAN_ADMIN" } })
    expect(progress).toMatchObject({ applies: true, status: "APPROVED", requiredLevels: 2, requirementFrozen: true, matchedRules: [{ id: "mid", name: "Mid-size loans" }] })
    expect(progress.levels.map((l) => [l.level, l.state])).toEqual([[1, "APPROVED"], [2, "APPROVED"], [3, "NOT_REQUIRED"]])
  })

  it("the maker never approves, at any level: the route refuses, and so does the database", async () => {
    await underReview("ap-maker", { amount: 500_000, inputStaff: [ids.bm] })
    expect(await approveAs("bm", "ap-maker")).toMatchObject({ status: 403, body: { approvalMatrix: "MAKER_CANNOT_APPROVE" } })
    // A first level done by someone else, then the maker (who has the authority) tries the second.
    expect((await approveAs("la1", "ap-maker")).status).toBe(200)
    expect(await approveAs("bm", "ap-maker")).toMatchObject({ status: 403, body: { approvalMatrix: "MAKER_CANNOT_APPROVE" } })
    const theCase = await caseOf("ap-maker")
    expect(await refusal(sql(`INSERT INTO "ApprovalStep" ("id","tenantId","caseId","applicationId","level","approverId","via") VALUES ('s-${randomUUID()}','${ids.tenant}','${theCase.id}','ap-maker',2,'${ids.bm}','ROLE')`))).toContain("cannot approve it")
  })

  it("the database refuses APPROVED while the chain is incomplete, a step out of order, one past the requirement, or one by the system account", async () => {
    const theCase = await caseOf("ap-maker")
    expect(await refusal(sql(`UPDATE "LoanApplication" SET "status" = 'APPROVED' WHERE "id" = 'ap-maker'`))).toContain("every required level must approve")
    const step = (level: number, approver: string) => sql(`INSERT INTO "ApprovalStep" ("id","tenantId","caseId","applicationId","level","approverId","via") VALUES ('s-${randomUUID()}','${ids.tenant}','${theCase.id}','ap-maker',${level},'${approver}','ROLE')`)
    expect(await refusal(step(3, ids.ad))).toContain("at a level the case requires")
    expect(await refusal(step(1, ids.ad))).toMatch(/in order|unique/i)
    await db.user.create({ data: { id: `ap-sys-${t}`, tenantId: ids.tenant, email: `ap-sys-${t}@system.invalid`, password: "!", role: "LOAN_ADMIN", active: false, isSystem: true } })
    expect(await refusal(step(2, `ap-sys-${t}`))).toContain("never the automated decisioning account")
  })

  it("a case's requirement is set once; its steps and escalations are append-only; the case never goes away", async () => {
    const theCase = await caseOf("ap-maker")
    expect(await refusal(sql(`UPDATE "ApprovalCase" SET "requiredLevels" = 1 WHERE "id" = '${theCase.id}'`))).toContain("set once")
    expect(await refusal(sql(`DELETE FROM "ApprovalCase" WHERE "id" = '${theCase.id}'`))).toContain("never goes away")
    expect(await refusal(sql(`UPDATE "ApprovalStep" SET "note" = 'x' WHERE "caseId" = '${theCase.id}'`))).toContain("append-only")
    expect(await refusal(sql(`DELETE FROM "ApprovalStep" WHERE "caseId" = '${theCase.id}'`))).toContain("append-only")
    expect(await refusal(sql(`UPDATE "ApprovalCase" SET "status" = 'APPROVED', "completedAt" = now() WHERE "id" = '${theCase.id}'`))).toContain("approved only when every required level has approved")
  })

  it("the decision engine cannot approve what needs staff approval, and may where none is required", async () => {
    await underReview("ap-engine", { amount: 500_000 })
    const gate = await inTenant(() => gateApproval({ tenantId: ids.tenant, application: { id: "ap-engine", appliedAmount: 500_000, productId: ids.product, branchId: ids.branch, riskGradeRank: null, inputStaffIds: [] }, user: { id: ids.la1, email: "s@system.invalid", role: "LOAN_ADMIN" }, automated: true }))
    expect(gate).toMatchObject({ kind: "respond", status: 409, body: { approvalMatrix: "AUTOMATION_NOT_PERMITTED" } })
    expect(await statusOf("ap-engine")).toBe("UNDER_REVIEW")
  })

  it("a delegation gives its level up to its amount until it ends; the step says it was delegated; revoking ends it", async () => {
    const day = 86_400_000
    const delegation = (over: Record<string, unknown> = {}) => ({ delegateId: ids.la2, level: 2, maxAmountCents: 600_000, validFrom: new Date(Date.now() - 60_000), validTo: new Date(Date.now() + 7 * day), reason: "Branch manager away on leave this week", ...over })
    // Authority cannot be passed on from a role that lacks it.
    await expect(grantDelegation({ tenantId: ids.tenant, actor: as.la1, delegation: delegation() })).rejects.toMatchObject({ code: "INVALID" })
    const granted = await inTenant(() => grantDelegation({ tenantId: ids.tenant, actor: as.bm, delegation: delegation() }))
    await underReview("ap-delegated", { amount: 500_000 })
    expect((await approveAs("la1", "ap-delegated")).status).toBe(200)
    const done = await approveAs("la2", "ap-delegated")
    expect(done.status, JSON.stringify(done.body)).toBe(200)
    expect(await stepsOf("ap-delegated")).toMatchObject([{ level: 1 }, { level: 2, approverId: ids.la2, via: "DELEGATION", delegationId: granted.id }])
    // Above the delegated amount it does not reach.
    await underReview("ap-over-limit", { amount: 650_000 })
    expect((await approveAs("la1", "ap-over-limit")).status).toBe(200)
    expect(await approveAs("la2", "ap-over-limit")).toMatchObject({ status: 403, body: { approvalMatrix: "LEVEL_AUTHORITY_REQUIRED" } })
    // Revoked: no more.
    await underReview("ap-revoked", { amount: 500_000 })
    await inTenant(() => revokeDelegation({ tenantId: ids.tenant, actor: as.bm, id: granted.id }))
    expect((await approveAs("la1", "ap-revoked")).status).toBe(200)
    expect(await approveAs("la2", "ap-revoked")).toMatchObject({ status: 403, body: { approvalMatrix: "LEVEL_AUTHORITY_REQUIRED" } })
    await expect(revokeDelegation({ tenantId: ids.tenant, actor: as.bm, id: granted.id })).rejects.toMatchObject({ code: "ALREADY_ENDED" })
  })

  it("a delegation recorded on someone else's behalf cannot name the recorder as delegate or exceed the recorder's level, and tells the delegator", async () => {
    const day = 86_400_000
    const base = { level: 2, maxAmountCents: 600_000, validFrom: new Date(Date.now() - 60_000), validTo: new Date(Date.now() + 7 * day), reason: "Recorded for the branch manager on leave" }
    // The administrator names themselves: refused (they would grant themselves the branch manager's authority).
    await expect(grantDelegation({ tenantId: ids.tenant, actor: as.ad, delegation: { ...base, delegatorId: ids.bm, delegateId: ids.ad } })).rejects.toMatchObject({ code: "INVALID" })
    // A loan admin acting for the branch manager is not allowed on behalf at all.
    await expect(grantDelegation({ tenantId: ids.tenant, actor: as.la1, delegation: { ...base, delegatorId: ids.bm, delegateId: ids.la2 } })).rejects.toMatchObject({ code: "FORBIDDEN" })
    // An administrator naming someone else is fine, is audited as on behalf, and the delegator is told.
    const made = await inTenant(() => grantDelegation({ tenantId: ids.tenant, actor: as.ad, delegation: { ...base, delegatorId: ids.bm, delegateId: ids.la2 } }))
    const audit = await db.auditLog.findFirstOrThrow({ where: { tenantId: ids.tenant, action: "APPROVAL_DELEGATION_GRANTED", entityId: made.id } })
    expect(audit.newValue).toMatchObject({ onBehalfOf: ids.bm, recordedBy: ids.ad, delegatorId: ids.bm, delegateId: ids.la2 })
    expect(await db.notification.count({ where: { tenantId: ids.tenant, userId: ids.bm, type: "APPROVAL_DELEGATED_ON_YOUR_BEHALF" } })).toBe(1)
    await inTenant(() => revokeDelegation({ tenantId: ids.tenant, actor: as.bm, id: made.id }))
  })

  it("the database holds a delegation's shape, and it is never edited or deleted", async () => {
    const row = await db.approvalDelegation.findFirstOrThrow({ where: { tenantId: ids.tenant } })
    const insert = (cols: string) => sql(`INSERT INTO "ApprovalDelegation" ("id","tenantId","delegatorId","delegateId","level","maxAmountCents","validFrom","validTo","reason","createdById") VALUES ('d-${randomUUID()}','${ids.tenant}',${cols})`)
    const ok = (over: Record<string, string> = {}) => { const v = { del: `'${ids.bm}'`, dg: `'${ids.la2}'`, lvl: "2", amt: "100", from: "now()", to: "now() + interval '5 days'", reason: "'a proper reason here'", ...over }; return `${v.del},${v.dg},${v.lvl},${v.amt},${v.from},${v.to},${v.reason},'${ids.bm}'` }
    await insert(ok())
    expect(await refusal(insert(ok({ to: "now() + interval '91 days'" })))).toContain("ApprovalDelegation_shape")
    expect(await refusal(insert(ok({ dg: `'${ids.bm}'` })))).toMatch(/ApprovalDelegation_shape|two active staff members/)
    expect(await refusal(insert(ok({ amt: "0" })))).toContain("ApprovalDelegation_shape")
    expect(await refusal(insert(ok({ reason: "'short'" })))).toContain("ApprovalDelegation_shape")
    expect(await refusal(sql(`UPDATE "ApprovalDelegation" SET "maxAmountCents" = 999999999 WHERE "id" = '${row.id}'`))).toContain("never edited")
    expect(await refusal(sql(`DELETE FROM "ApprovalDelegation" WHERE "id" = '${row.id}'`))).toContain("never goes away")
  })

  it("the committee's level waits for its decision: nothing, a deferral or a decline blocks; an approval with conditions lets the chain complete", async () => {
    await underReview("ap-big", { amount: 800_000, inputStaff: [ids.officer] })
    expect((await approveAs("la1", "ap-big")).status).toBe(200)
    // Not at the committee yet: the branch manager has not approved.
    await expect(inTenant(() => recordCommitteeDecision({ tenantId: ids.tenant, actor: as.ad, applicationId: "ap-big", decision: { decision: "APPROVED", meetingDate: TODAY, attendees: ["A. Dlamini"], conditions: [], rationale: "Too early for this one" } }))).rejects.toMatchObject({ code: "NOT_AT_COMMITTEE" })
    expect((await approveAs("bm", "ap-big")).status).toBe(200)
    expect(await approveAs("ad2", "ap-big")).toMatchObject({ status: 409, body: { approvalMatrix: "COMMITTEE_DECISION_REQUIRED" } })
    const decide = (decision: "APPROVED" | "DECLINED" | "DEFERRED", conditions: string[] = [], actor = as.ad) =>
      inTenant(() => recordCommitteeDecision({ tenantId: ids.tenant, actor, applicationId: "ap-big", decision: { decision, meetingDate: TODAY, attendees: ["A. Dlamini", "B. Mokoena"], conditions, rationale: `Committee ${decision.toLowerCase()} this application` } }))
    await expect(decide("APPROVED", [], as.la2)).rejects.toMatchObject({ code: "FORBIDDEN" })
    await decide("DEFERRED")
    expect(await approveAs("ad2", "ap-big")).toMatchObject({ status: 409, body: { approvalMatrix: "COMMITTEE_DECISION_REQUIRED" } })
    await decide("DECLINED")
    expect(await approveAs("ad2", "ap-big")).toMatchObject({ status: 409, body: { approvalMatrix: "COMMITTEE_DECLINED" } })
    await decide("APPROVED", ["Obtain a signed employer letter before disbursement", "Insure the vehicle with the bank noted"])
    // Whoever recorded the committee's decision cannot also give the committee level's approval: not the route, not the database.
    expect(await approveAs("ad", "ap-big")).toMatchObject({ status: 409, body: { approvalMatrix: "COMMITTEE_RECORDER_CANNOT_APPROVE" } })
    const bigCase = await caseOf("ap-big")
    expect(await refusal(sql(`INSERT INTO "ApprovalStep" ("id","tenantId","caseId","applicationId","level","approverId","via") VALUES ('s-${randomUUID()}','${ids.tenant}','${bigCase.id}','ap-big',3,'${ids.ad}','ROLE')`))).toContain("recorded the credit committee")
    // ...and someone who approved a lower level cannot record it.
    await expect(decide("APPROVED", [], as.bm)).rejects.toMatchObject({ code: "APPROVER" })
    expect(await refusal(sql(`INSERT INTO "CreditCommitteeDecision" ("id","tenantId","caseId","applicationId","level","decision","meetingDate","conditions","rationale","recordedById") VALUES ('c-${randomUUID()}','${ids.tenant}','${bigCase.id}','ap-big',3,'DEFERRED',now(),'[]'::jsonb,'a proper rationale here','${ids.la1}')`))).toContain("approved a level of the case")
    const final = await approveAs("ad2", "ap-big")
    expect(final.status, JSON.stringify(final.body)).toBe(200)
    expect(await statusOf("ap-big")).toBe("APPROVED")
    expect((await stepsOf("ap-big"))[2]).toMatchObject({ level: 3, approverId: ids.ad2, conditions: ["Obtain a signed employer letter before disbursement", "Insure the vehicle with the bank noted"] })
    expect(await db.creditCommitteeDecision.count({ where: { tenantId: ids.tenant, applicationId: "ap-big" } })).toBe(3)
    const progress = await loadApprovalProgress({ tenantId: ids.tenant, applicationId: "ap-big", viewer: { id: ids.ad2, role: "ADMIN" } })
    expect(progress.committeeDecisions.map((d) => d.decision)).toEqual(["DEFERRED", "DECLINED", "APPROVED"])
    expect(progress.levels[2]).toMatchObject({ committee: true, state: "APPROVED", conditions: expect.arrayContaining(["Obtain a signed employer letter before disbursement"]) })
  })

  it("the database refuses committee decisions that carry conditions on a decline, and edits of any decision", async () => {
    const row = await db.creditCommitteeDecision.findFirstOrThrow({ where: { tenantId: ids.tenant } })
    expect(await refusal(sql(`UPDATE "CreditCommitteeDecision" SET "rationale" = 'Rewritten after the fact' WHERE "id" = '${row.id}'`))).toContain("append-only")
    expect(await refusal(sql(`INSERT INTO "CreditCommitteeDecision" ("id","tenantId","caseId","applicationId","level","decision","meetingDate","conditions","rationale","recordedById") VALUES ('c-${randomUUID()}','${ids.tenant}','${row.caseId}','ap-big',3,'DECLINED','2026-11-05','["a condition"]'::jsonb,'a proper rationale here','${ids.ad}')`))).toContain("CreditCommitteeDecision_shape")
  })

  it("an overdue level escalates to the next up (its people are told, once), climbs again if still waiting, and reminds the top", async () => {
    await underReview("ap-slow", { amount: 800_000, inputStaff: [ids.officer] })
    // The review has started: the case (and its clock) opens with it. Make level 1 overdue.
    await inTenant(() => openApprovalCaseSafely({ tenantId: ids.tenant, applicationId: "ap-slow" }))
    const theCase = await caseOf("ap-slow")
    await sql(`UPDATE "ApprovalCase" SET "dueAt" = now() - interval '1 hour' WHERE "id" = '${theCase.id}'`)
    const now = new Date()
    expect(await escalateOverdueApprovals({ now })).toMatchObject({ escalated: 1, failed: 0 })
    expect(await db.approvalEscalation.findMany({ where: { caseId: theCase.id } })).toMatchObject([{ fromLevel: 1, toLevel: 2 }])
    const told = await db.notification.findMany({ where: { tenantId: ids.tenant, type: "APPROVAL_ESCALATED", entityId: "ap-slow" } })
    expect(told.map((n) => n.userId)).toEqual([ids.bm])
    // Not overdue again until another SLA has passed: a second run does nothing.
    expect(await escalateOverdueApprovals({ now })).toMatchObject({ escalated: 0, reminded: 0 })
    // Still waiting a full SLA later: it climbs to level 3 (the committee's ADMINs).
    expect((await escalateOverdueApprovals({ now: new Date(now.getTime() + 25 * 3_600_000) })).escalated).toBeGreaterThanOrEqual(1)
    expect((await db.approvalEscalation.findMany({ where: { caseId: theCase.id }, orderBy: { createdAt: "asc" } })).map((e) => [e.fromLevel, e.toLevel])).toEqual([[1, 2], [1, 3]])
    expect(await db.approvalEscalation.count({ where: { caseId: theCase.id } })).toBe(2)
  })

  it("leaving review any other way ends the case, and a new review opens a fresh one", async () => {
    await underReview("ap-cancelled", { amount: 500_000 })
    expect((await approveAs("la1", "ap-cancelled")).status).toBe(200)
    const first = await caseOf("ap-cancelled")
    await sql(`UPDATE "LoanApplication" SET "status" = 'CANCELLED' WHERE "id" = 'ap-cancelled'`)
    expect(await db.approvalCase.findUniqueOrThrow({ where: { id: first.id } })).toMatchObject({ status: "CLOSED" })
    expect(await refusal(sql(`UPDATE "ApprovalCase" SET "status" = 'OPEN', "completedAt" = NULL WHERE "id" = '${first.id}'`))).toContain("cannot be reopened")
  })

  it("only one open case per application", async () => {
    await underReview("ap-twice", { amount: 300_000 })
    await inTenant(() => gateApproval({ tenantId: ids.tenant, application: { id: "ap-twice", appliedAmount: 300_000, productId: ids.product, branchId: ids.branch, riskGradeRank: null, inputStaffIds: [ids.ad] }, user: as.ad, automated: false }))
    const open = await caseOf("ap-twice")
    const message = await refusal(sql(`INSERT INTO "ApprovalCase" ("id","tenantId","applicationId") VALUES ('c-${randomUUID()}','${ids.tenant}','ap-twice')`))
    expect(message, message).toMatch(/one_open|unique|23505/i)
    expect(open.status).toBe("OPEN")
  })

  it("a matrix switched off puts the lender back on the single-approver flow for new applications", async () => {
    const draft = await createDraft({ tenantId: ids.tenant, actor: as.maker, kind: MATRIX_KIND, title: "Off", payload: { ...MATRIX, enabled: false } })
    await submit({ tenantId: ids.tenant, actor: as.maker, id: draft.id })
    await approve({ tenantId: ids.tenant, actor: as.checker, id: draft.id })
    await underReview("ap-off", { amount: 500_000 })
    const res = await approveAs("la1", "ap-off")
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(await statusOf("ap-off")).toBe("APPROVED")
    expect(await db.approvalCase.count({ where: { tenantId: ids.tenant, applicationId: "ap-off" } })).toBe(0)
  })
})
