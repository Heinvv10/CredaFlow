import type { prisma } from "@/lib/prisma"

/**
 * The contract the product engine (A5) and the approval matrix (A6) read.
 *
 *   LoanApplication.riskGrade           the grade label of the lender's approved
 *                                       scorecard ("A".."E" or whatever the lender
 *                                       configured), or null: not graded
 *   LoanApplication.riskScore           the score behind it
 *   LoanApplication.riskGradeRank       the grade band's position in that scorecard,
 *                                       0 = highest-scoring band; compare by this,
 *                                       never by the label
 *   LoanApplication.riskPricingTier     the band's opaque pricing label, or null
 *   LoanApplication.riskGradeVersionId  the rule set version (and so the scorecard)
 *                                       that produced it
 *   LoanApplication.riskGradedAt        when it was set
 *
 * Written only by a LIVE run, in the same transaction as what the run did with
 * the application, and replaced by a later LIVE run. A SHADOW run records its
 * grade on its AutoDecisionRun alone: a rehearsal never moves pricing. When the
 * lender's challenger decides, the grade comes from the challenger's scorecard,
 * so grades of two applications are comparable only when their
 * `riskGradeVersionId` match (or the lender's versions share band layouts).
 * Nothing prices by `riskPricingTier` yet: that is the product engine's job.
 */
export interface GradeProfile {
  grade: string
  score: number | null
  gradedAt: Date
  /** The pricing label of the grade's band, for the product engine to price by. */
  pricingTier: string | null
  /** Position of the grade's band in the scorecard, 0 = highest score. */
  rank: number
  ruleSetVersionId: string
}

type Db = Pick<typeof prisma, "loanApplication">

export async function getRiskGrade(db: Db, tenantId: string, applicationId: string): Promise<GradeProfile | null> {
  const a = await db.loanApplication.findFirst({
    where: { id: applicationId, tenantId },
    select: { riskGrade: true, riskScore: true, riskGradedAt: true, riskGradeRank: true, riskPricingTier: true, riskGradeVersionId: true },
  })
  if (!a?.riskGrade || !a.riskGradedAt || a.riskGradeRank === null || !a.riskGradeVersionId) return null
  return { grade: a.riskGrade, score: a.riskScore, gradedAt: a.riskGradedAt, pricingTier: a.riskPricingTier, rank: a.riskGradeRank, ruleSetVersionId: a.riskGradeVersionId }
}
