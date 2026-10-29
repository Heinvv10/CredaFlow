import type { prisma } from "@/lib/prisma"
import { parseScorecard } from "./validate-scorecard"

/**
 * The contract the product engine (A5) and the approval matrix (A6) read.
 *
 *   LoanApplication.riskGrade      the grade label of the lender's approved
 *                                  scorecard ("A".."E" or whatever the lender
 *                                  configured), or null: not graded
 *   LoanApplication.riskScore      the score behind it
 *   LoanApplication.riskGradedAt   when it was set
 *
 * A grade is set whenever the decision engine runs for the application
 * (SHADOW or LIVE) and a scorecard applies; a later run replaces it. It is a
 * label chosen by the lender, not an ordinal: consumers must not assume
 * "A" is best or that grades are single letters. Compare through the scorecard's
 * band order (`GradeProfile.rank`, 0 = the best band), never by string order.
 */
export interface GradeProfile {
  grade: string
  score: number | null
  gradedAt: Date
  /** The pricing label of the grade's band, for the product engine to price by. */
  pricingTier: string | null
  /** Position of the grade's band in the scorecard, 0 = highest score. */
  rank: number
  ruleSetVersionId: string | null
}

type Db = Pick<typeof prisma, "loanApplication" | "autoDecisionRun" | "decisionRuleSetVersion">

export async function getRiskGrade(db: Db, tenantId: string, applicationId: string): Promise<GradeProfile | null> {
  const application = await db.loanApplication.findFirst({ where: { id: applicationId, tenantId }, select: { riskGrade: true, riskScore: true, riskGradedAt: true } })
  if (!application?.riskGrade || !application.riskGradedAt) return null
  const run = await db.autoDecisionRun.findFirst({
    where: { tenantId, applicationId, riskGrade: application.riskGrade },
    orderBy: { createdAt: "desc" },
    select: { ruleSetVersionId: true },
  })
  const version = run ? await db.decisionRuleSetVersion.findFirst({ where: { id: run.ruleSetVersionId, tenantId }, select: { scorecard: true } }) : null
  const card = version?.scorecard ? parseScorecard(version.scorecard) : null
  const rank = card ? card.bands.findIndex((b) => b.grade === application.riskGrade) : -1
  return {
    grade: application.riskGrade,
    score: application.riskScore,
    gradedAt: application.riskGradedAt,
    pricingTier: rank >= 0 ? (card!.bands[rank].pricingTier ?? null) : null,
    rank: rank >= 0 ? rank : Number.MAX_SAFE_INTEGER,
    ruleSetVersionId: run?.ruleSetVersionId ?? null,
  }
}
