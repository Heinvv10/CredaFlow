import { prisma } from "@/lib/prisma"
import type { UserRole } from "@/lib/permissions"
import { loadApprovalProgress, type ApprovalProgress } from "./progress"

export interface CommitteePack {
  generatedAt: string
  application: {
    id: string; reference: string; status: string; submittedAt: string | null; appliedAmountCents: number; termDays: number; purpose: string | null
    productName: string; branchName: string | null; channel: "STAFF" | "PORTAL" | null
  }
  client: {
    name: string; idNumberMasked: string; employmentStatus: string | null; employerName: string | null
    monthlyIncomeCents: number; monthlyExpensesCents: number; kycStatus: string
  } | null
  affordability: { netDisposableIncomeCents: number | null; ndiAfterLoanCents: number | null; totalExistingDebtCents: number | null }
  bureau: { checkedAt: string; provider: string; score: number | null; riskGrade: string | null; adverse: boolean; judgement: boolean; notice: boolean; underDebtReview: boolean; deceased: boolean; unscoreable: boolean } | null
  score: { grade: string | null; score: number | null; rank: number | null; pricingTier: string | null; gradedAt: string | null }
  engineRuns: Array<{ at: string; mode: string; verdict: string; reasonCodes: string[]; execution: string; riskGrade: string | null }>
  history: { loans: Array<{ reference: string; status: string; principalCents: number; since: string }>; otherApplications: number }
  approval: ApprovalProgress
}

/** The mask keeps the last four characters: enough to match a record, not to impersonate. */
const mask = (id: string) => (id.length <= 4 ? "****" : `${"*".repeat(id.length - 4)}${id.slice(-4)}`)

/** Everything the credit committee needs on one application, read once. Personal data: the caller checks the permission and logs the view. */
export async function loadCommitteePack(input: { tenantId: string; applicationId: string; viewer: { id: string; role: UserRole }; now?: Date }): Promise<CommitteePack | null> {
  const now = input.now ?? new Date()
  const { tenantId, applicationId } = input
  const app = await prisma.loanApplication.findFirst({
    where: { id: applicationId, tenantId },
    include: { product: { select: { name: true } }, branch: { select: { name: true } }, client: true },
  })
  if (!app) return null
  const [bureau, runs, loans, others, approval, submitted] = await Promise.all([
    app.clientId ? prisma.creditBureauCheck.findFirst({ where: { tenantId, clientId: app.clientId, ok: true }, orderBy: { createdAt: "desc" } }) : Promise.resolve(null),
    prisma.autoDecisionRun.findMany({ where: { tenantId, applicationId }, orderBy: { createdAt: "desc" }, take: 5 }),
    app.clientId ? prisma.loan.findMany({ where: { tenantId, clientId: app.clientId }, orderBy: { createdAt: "desc" }, take: 20, select: { reference: true, status: true, principal: true, createdAt: true } }) : Promise.resolve([]),
    app.clientId ? prisma.loanApplication.count({ where: { tenantId, clientId: app.clientId, id: { not: applicationId } } }) : Promise.resolve(0),
    loadApprovalProgress({ tenantId, applicationId, viewer: input.viewer, now }),
    prisma.auditLog.findFirst({ where: { tenantId, entity: "LoanApplication", entityId: applicationId, action: "APPLICATION_SUBMITTED_BY_CLIENT" }, select: { id: true } }),
  ])
  return {
    generatedAt: now.toISOString(),
    application: {
      id: app.id, reference: app.reference, status: app.status, submittedAt: app.submittedAt?.toISOString() ?? null, appliedAmountCents: app.appliedAmount,
      termDays: app.appliedTermDays, purpose: app.purpose, productName: app.product.name, branchName: app.branch?.name ?? null, channel: app.submittedAt ? (submitted ? "PORTAL" : "STAFF") : null,
    },
    client: app.client ? {
      name: `${app.client.firstName} ${app.client.lastName}`.trim(), idNumberMasked: mask(app.client.idNumber), employmentStatus: app.client.employmentStatus ?? null,
      employerName: app.client.employerName ?? null, monthlyIncomeCents: app.client.monthlyIncome, monthlyExpensesCents: app.client.monthlyExpenses, kycStatus: app.client.kycStatus,
    } : null,
    affordability: { netDisposableIncomeCents: app.netDisposableIncome, ndiAfterLoanCents: app.affordabilityNDI, totalExistingDebtCents: app.totalExistingDebt },
    bureau: bureau ? {
      checkedAt: bureau.createdAt.toISOString(), provider: bureau.provider, score: bureau.score, riskGrade: bureau.riskGrade, adverse: bureau.hasAdverse, judgement: bureau.hasJudgement,
      notice: bureau.hasNotice, underDebtReview: bureau.underDebtReview, deceased: bureau.deceased, unscoreable: bureau.unscoreable,
    } : null,
    score: { grade: app.riskGrade, score: app.riskScore, rank: app.riskGradeRank, pricingTier: app.riskPricingTier, gradedAt: app.riskGradedAt?.toISOString() ?? null },
    engineRuns: runs.map((r) => ({ at: r.createdAt.toISOString(), mode: r.mode, verdict: r.verdict, reasonCodes: Array.isArray(r.reasonCodes) ? (r.reasonCodes as string[]) : [], execution: r.execution, riskGrade: r.riskGrade })),
    history: { loans: loans.map((l) => ({ reference: l.reference, status: l.status, principalCents: l.principal, since: l.createdAt.toISOString() })), otherApplications: others },
    approval,
  }
}
