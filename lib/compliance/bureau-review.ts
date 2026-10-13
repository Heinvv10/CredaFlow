import type { Prisma } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { lockAffordabilityApplicationEvidence } from "@/lib/affordability/evidence-locks"
import { bureauSubjectFingerprint } from "@/lib/compliance/bureau-subject"
import { isSimulatedBureauCheck } from "@/lib/decision/bureau-simulated"
import { getCreditReport } from "@/lib/integrations/experian"
import { buildExperianEnquiryInput } from "@/lib/integrations/experian-input"

export type BureauReviewRequest = {
  tenantId: string
  applicationId: string
  clientId: string
  reviewGeneration: string
}

export type BureauReviewResult = "stored" | "skipped" | "stale" | "failed"

type BureauReviewTransaction = Parameters<
  Parameters<typeof prisma.$transaction>[0]
>[0]

async function currentReview(
  db: Pick<BureauReviewTransaction, "loanApplication">,
  opts: BureauReviewRequest,
) {
  const application = await db.loanApplication.findUnique({
    where: { id: opts.applicationId, tenantId: opts.tenantId },
    select: {
      status: true,
      clientId: true,
      bureauReviewGeneration: true,
    },
  })
  return application?.status === "UNDER_REVIEW" &&
    application.clientId === opts.clientId &&
    application.bureauReviewGeneration === opts.reviewGeneration
}

async function storeComplianceRecordIfCurrent(
  opts: BureauReviewRequest,
  data: Prisma.ComplianceRecordUncheckedCreateInput,
): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    await lockAffordabilityApplicationEvidence(tx, opts)
    if (!(await currentReview(tx, opts))) return false
    await tx.complianceRecord.create({ data })
    return true
  })
}

/**
 * Run a bureau enquiry for one exact review cycle. The generation is checked
 * before provider I/O and again while holding the same application lock used
 * by approval. A late response can be retained nowhere as current evidence.
 */
export async function runBureauReviewCheck(
  opts: BureauReviewRequest,
): Promise<BureauReviewResult> {
  try {
    if (!(await currentReview(prisma, opts))) return "stale"

    // POPIA gate: granular consent is authoritative when it exists. The
    // umbrella flag remains the legacy fallback.
    const consent = await prisma.client.findUnique({
      where: { id: opts.clientId },
      select: {
        popiaConsentGiven: true,
        consent: { select: { creditBureauEnquiry: true, withdrawnAt: true } },
      },
    })
    const granular = consent?.consent ?? null
    const consentGranted = granular
      ? granular.creditBureauEnquiry && granular.withdrawnAt === null
      : consent?.popiaConsentGiven === true

    if (!consentGranted) {
      const reason = granular
        ? (granular.withdrawnAt ? "CONSENT_WITHDRAWN" : "CONSENT_REFUSED")
        : "CONSENT_MISSING"
      const stored = await storeComplianceRecordIfCurrent(opts, {
        tenantId: opts.tenantId,
        type: "CREDIT_BUREAU_CHECK",
        status: "ACKNOWLEDGED",
        referenceId: opts.applicationId,
        completedAt: new Date(),
        data: {
          clientId: opts.clientId,
          provider: "experian",
          reviewGeneration: opts.reviewGeneration,
          skipped: true,
          reason,
        },
      })
      return stored ? "skipped" : "stale"
    }

    const client = await prisma.client.findUnique({
      where: { id: opts.clientId },
      select: {
        idNumber: true,
        firstName: true,
        lastName: true,
        gender: true,
        dateOfBirth: true,
      },
    })
    if (!client) return "failed"
    if (!(await currentReview(prisma, opts))) return "stale"

    const result = await getCreditReport(
      buildExperianEnquiryInput({
        idNumber: client.idNumber,
        firstName: client.firstName,
        lastName: client.lastName,
        gender: client.gender === "MALE" ? "M" : client.gender === "FEMALE" ? "F" : null,
        dateOfBirth: client.dateOfBirth,
        consentGranted: true,
        applicationId: opts.applicationId,
      }),
    )
    const subjectFingerprint = bureauSubjectFingerprint({
      id: opts.clientId,
      ...client,
    })
    const hasAdverse = (result.adverseInfo?.length ?? 0) > 0

    // Provider-scoped score comparison: Sigma scores are not comparable to
    // historical TransUnion scales.
    const SCORE_DROP_THRESHOLD = 50
    let scoreDropAlert: { previous: number; current: number; drop: number } | undefined
    if (result.score != null) {
      // A simulated earlier row is not a real score; filtered here, not in SQL,
      // because a JSON-path NOT drops rows whose key is absent.
      const priorChecks = await prisma.creditBureauCheck.findMany({
        where: {
          tenantId: opts.tenantId,
          clientId: opts.clientId,
          applicationId: { not: opts.applicationId },
          provider: "experian",
          ok: true,
          score: { not: null },
        },
        orderBy: { createdAt: "desc" },
        take: 20,
        select: { score: true, obligations: true },
      })
      const previous = priorChecks.find((check) => !isSimulatedBureauCheck(check.obligations))
      if (previous?.score != null) {
        const drop = previous.score - result.score
        if (drop >= SCORE_DROP_THRESHOLD) {
          scoreDropAlert = { previous: previous.score, current: result.score, drop }
        }
      }
    }

    const obligations = result.totalMonthlyObligations != null || scoreDropAlert || result.simulated
      ? {
          ...(result.simulated ? { simulated: true } : {}),
          ...(result.totalMonthlyObligations != null
            ? { totalMonthly: result.totalMonthlyObligations }
            : {}),
          ...(scoreDropAlert ? { scoreDropAlert } : {}),
        }
      : undefined
    const bureauCheckData = {
      tenantId: opts.tenantId,
      clientId: opts.clientId,
      applicationId: opts.applicationId,
      reviewGeneration: opts.reviewGeneration,
      subjectFingerprint,
      provider: "experian",
      score: result.score ?? null,
      riskGrade: result.riskGrade ?? null,
      adverseInfo: result.adverseInfo ?? [],
      hasAdverse,
      deceased: result.deceased ?? false,
      underDebtReview: result.underDebtReview ?? false,
      hasJudgement: result.hasJudgement ?? false,
      hasNotice: result.hasNotice ?? false,
      unscoreable: result.unscoreable ?? false,
      declineReasons: result.declineReasons ?? [],
      ok: result.ok,
      errorMessage: result.error ?? null,
      obligations,
    } satisfies Prisma.CreditBureauCheckUncheckedCreateInput

    const stored = await prisma.$transaction(async (tx) => {
      await lockAffordabilityApplicationEvidence(tx, opts)
      if (!(await currentReview(tx, opts))) return false
      await Promise.all([
        tx.creditBureauCheck.create({ data: bureauCheckData }),
        tx.complianceRecord.create({
          data: {
            tenantId: opts.tenantId,
            type: "CREDIT_BUREAU_CHECK",
            status: result.ok ? "COMPLETED" : "PENDING",
            referenceId: opts.applicationId,
            data: {
              clientId: opts.clientId,
              provider: "experian",
              reviewGeneration: opts.reviewGeneration,
              score: result.score ?? null,
              riskGrade: result.riskGrade ?? null,
              adverseInfo: result.adverseInfo ?? [],
              deceased: result.deceased ?? false,
              error: result.error ?? null,
              errorClass: result.errorClass ?? null,
            },
            completedAt: result.ok ? new Date() : null,
          },
        }),
      ])
      return true
    })
    return stored ? "stored" : "stale"
  } catch (error) {
    const stored = await storeComplianceRecordIfCurrent(opts, {
      tenantId: opts.tenantId,
      type: "CREDIT_BUREAU_CHECK",
      status: "PENDING",
      referenceId: opts.applicationId,
      data: {
        clientId: opts.clientId,
        provider: "experian",
        reviewGeneration: opts.reviewGeneration,
        error: error instanceof Error ? error.message : "bureau check failed",
      },
      completedAt: null,
    }).catch((recordError) => {
      console.error("[bureau-review] failed to record bureau-check failure:", recordError)
      return false
    })
    return stored ? "failed" : "stale"
  }
}
