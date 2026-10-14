import type { Prisma } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { lockAffordabilityApplicationEvidence } from "@/lib/affordability/evidence-locks"
import { bureauSubjectFingerprint } from "@/lib/compliance/bureau-subject"
import { isSimulatedBureauCheck } from "@/lib/decision/bureau-simulated"
import { openBureauCredentials, type BureauCredentialMap } from "@/lib/bureau/credentials"
import { runBureauEnquiry } from "@/lib/bureau/enquiry"
import { bureauCheckRow, scoreDropAlert } from "@/lib/bureau/persist"
import { bureauProviderOrder } from "@/lib/bureau/registry"
import type { BureauPurpose } from "@/lib/bureau/types"

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

/** Origination enquiries are affordability assessments (NCA s.81). */
const REVIEW_PURPOSE: BureauPurpose = "AFFORDABILITY_ASSESSMENT"

/** A tenant with no config row keeps the schema default: Experian only. */
const DEFAULT_ORDER = { bureauProviderOrder: ["experian"] }

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
 * Run a bureau enquiry for one exact review cycle, across the tenant's bureaus
 * (TenantConfig.bureauProviderOrder; fallback rule in lib/bureau/enquiry.ts).
 * The generation is checked before every provider call and again while holding
 * the same application lock used by approval. A late response can be retained
 * nowhere as current evidence. Every attempt of a current run is stored as its
 * own CreditBureauCheck row.
 */
export async function runBureauReviewCheck(
  opts: BureauReviewRequest,
): Promise<BureauReviewResult> {
  let primary = "experian"
  try {
    if (!(await currentReview(prisma, opts))) return "stale"

    const config = await prisma.tenantConfig.findUnique({
      where: { tenantId: opts.tenantId },
      select: { bureauProviderOrder: true, bureauCredentials: true },
    })
    const order = bureauProviderOrder(config ?? DEFAULT_ORDER)
    primary = order[0]

    // POPIA gate: granular consent is authoritative when it exists. The
    // umbrella flag remains the legacy fallback.
    const consent = await prisma.client.findUnique({
      where: { id: opts.clientId },
      select: {
        popiaConsentGiven: true,
        consent: { select: { id: true, creditBureauEnquiry: true, withdrawnAt: true } },
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
          provider: primary,
          reviewGeneration: opts.reviewGeneration,
          skipped: true,
          reason,
        },
      })
      return stored ? "skipped" : "stale"
    }
    const consentReference = granular
      ? `ClientConsent:${granular.id}`
      : `Client.popiaConsentGiven:${opts.clientId}`

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

    let credentials: BureauCredentialMap | null = null
    const run = await runBureauEnquiry({
      request: {
        tenantId: opts.tenantId,
        consumer: {
          idNumber: client.idNumber,
          firstName: client.firstName,
          lastName: client.lastName,
          gender: client.gender === "MALE" ? "M" : client.gender === "FEMALE" ? "F" : null,
          dateOfBirth: client.dateOfBirth,
        },
        purpose: REVIEW_PURPOSE,
        consent: { reference: consentReference },
        reference: opts.applicationId,
      },
      order,
      credentialsFor: (providerId) => {
        credentials ??= openBureauCredentials(config?.bureauCredentials ?? null)
        return credentials[providerId] ?? null
      },
      beforeAttempt: () => currentReview(prisma, opts),
    })
    if (run.stale) return "stale"

    const subjectFingerprint = bureauSubjectFingerprint({
      id: opts.clientId,
      ...client,
    })
    const report = run.report?.report ?? null

    // Provider-scoped score comparison: scores from different bureaus (and
    // the Sigma band vs historical TransUnion scales) are not comparable.
    let alert: ReturnType<typeof scoreDropAlert>
    const score = report?.score?.value ?? null
    if (report && score != null) {
      // A simulated earlier row is not a real score; filtered here, not in SQL,
      // because a JSON-path NOT drops rows whose key is absent.
      const priorChecks = await prisma.creditBureauCheck.findMany({
        where: {
          tenantId: opts.tenantId,
          clientId: opts.clientId,
          applicationId: { not: opts.applicationId },
          provider: report.provider,
          ok: true,
          score: { not: null },
        },
        orderBy: { createdAt: "desc" },
        take: 20,
        select: { score: true, obligations: true },
      })
      const previous = priorChecks.find((check) => !isSimulatedBureauCheck(check.obligations))
      alert = scoreDropAlert(previous?.score, score)
    }

    const base = {
      tenantId: opts.tenantId,
      clientId: opts.clientId,
      applicationId: opts.applicationId,
      reviewGeneration: opts.reviewGeneration,
      subjectFingerprint,
    }
    const rows = run.attempts.map((attempt) => bureauCheckRow(base, attempt, attempt.status === "OK" ? alert : undefined))
    const last = run.attempts[run.attempts.length - 1]
    const failure = last.status === "OK" ? null : last
    const attempts = run.attempts.map((a) => ({ attempt: a.attempt, provider: a.provider, status: a.status }))

    const stored = await prisma.$transaction(async (tx) => {
      await lockAffordabilityApplicationEvidence(tx, opts)
      if (!(await currentReview(tx, opts))) return false
      for (const data of rows) await tx.creditBureauCheck.create({ data })
      await tx.complianceRecord.create({
        data: {
          tenantId: opts.tenantId,
          type: "CREDIT_BUREAU_CHECK",
          status: report ? "COMPLETED" : "PENDING",
          referenceId: opts.applicationId,
          data: {
            clientId: opts.clientId,
            provider: last.provider,
            reviewGeneration: opts.reviewGeneration,
            score,
            riskGrade: report?.score?.riskGrade ?? null,
            adverseInfo: report?.defaults ?? [],
            deceased: report?.deceased ?? false,
            error: failure?.error ?? null,
            errorClass: failure?.errorClass ?? null,
            rawSha256: report?.rawSha256 ?? null,
            attempts,
          },
          completedAt: report ? new Date() : null,
        },
      })
      await logAuditStrict({
        tenantId: opts.tenantId,
        action: AuditAction.BUREAU_ENQUIRY_RUN,
        entity: "LoanApplication",
        entityId: opts.applicationId,
        newValue: {
          reviewGeneration: opts.reviewGeneration,
          purpose: REVIEW_PURPOSE,
          provider: report?.provider ?? null,
          simulated: report?.simulated ?? false,
          attempts,
        },
      }, tx)
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
        provider: primary,
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
