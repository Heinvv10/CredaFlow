import { Prisma } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { bureauStalenessCutoff } from "@/lib/compliance/bureau"
import { approvalEvidenceApplicationInclude } from "@/lib/affordability/current-approval"
import { unresolvedNonBiometricDocumentMismatchWhere } from "@/lib/kyc/document-mismatches"
import {
  CORE_KYC_DOCUMENT_TYPES,
  latestSelfieOrder,
  readCompositeKycState,
  type CompositeKycReader,
} from "@/lib/kyc/document-state"
import { matchesBlockingSelfie, matchesIdPortraitRefusal } from "@/lib/kyc/in-person-verification"
import {
  computeReadiness,
  type ApplicationReadiness,
  type ReadinessApplication,
} from "@/lib/applications/readiness"

/** Only these statuses draw a chip, so only these are loaded for. */
export const READINESS_STATUSES = ["SUBMITTED", "UNDER_REVIEW", "APPROVED"] as const

/**
 * Everything `computeReadiness` reads off the application row, as one Prisma
 * `select`. Kept beside the readiness module so adding a blocker that needs a
 * new column fails to compile until the board actually selects it.
 */
export const readinessApplicationSelect = {
  id: true,
  tenantId: true,
  clientId: true,
  status: true,
  submittedAt: true,
  appliedAmount: true,
  appliedTermDays: true,
  affordabilityResult: true,
  clientAffordabilityDeclaredAt: true,
  recklessLendingAssessed: true,
  recklessLendingAssessedAt: true,
  recklessLendingAssessedById: true,
  repaymentMethod: true,
  bureauReviewGeneration: true,
  bureauOverrideReason: true,
  bureauOverrideById: true,
  bureauOverrideAt: true,
  approvedAmount: true,
  approvedTermDays: true,
  productId: true,
  initiationFeePayment: true,
  existingDebtObligations: true,
  pasqVersion: true,
  pasqGeneratedAt: true,
  pasqDocumentId: true,
  pasqDocumentSha256: true,
  pasqEvidence: true,
  pasqEvidenceSha256: true,
  pasqAcknowledgedAt: true,
  pasqAcknowledgedBy: true,
  pasqAcknowledgedSha256: true,
  approvedPasqDocumentSha256: true,
  agreementGeneratedAt: true,
  agreementSignedAt: true,
  agreementSignedMethod: true,
  agreementSignedByUserId: true,
  agreementSignatureData: true,
  agreementDocumentId: true,
  agreementDocumentSha256: true,
  agreementCountersignedAt: true,
  agreementCountersignedById: true,
  agreementCountersignedByName: true,
  agreementCountersignedByEmail: true,
  agreementCountersignatureData: true,
  agreementCountersignatureSha256: true,
  agreementCountersignatureEnvelopeSha256: true,
  agreementCountersignedDocumentSha256: true,
  creditLifeElection: true,
  creditLifeProductId: true,
  creditLifeProductName: true,
  creditLifeInsurerId: true,
  creditLifeInsurerName: true,
  creditLifeMonthlyPremiumCents: true,
  creditLifeDisclosureVersion: true,
  creditLifeDisclosureSha256: true,
  creditLifeDisclosureAcknowledgedAt: true,
  creditLifeDisclosureAcknowledgedBy: true,
  debitMandatePreparedAt: true,
  debitMandateReference: true,
  debitMandateDraftSha256: true,
  debitMandateEvidence: true,
  debitMandateEvidenceSha256: true,
  debitMandateSignedAt: true,
  debitMandateSignedMethod: true,
  debitMandateSignatureData: true,
  debitMandateSignatureSha256: true,
  debitMandateDocumentId: true,
  debitMandateDocumentSha256: true,
  // The approval-evidence relations come from the payout path own validator,
  // not a hand-copied list: judging an approval on a different column set than
  // the route judges it on is the drift this module exists to avoid.
  product: approvalEvidenceApplicationInclude.product,
  client: {
    select: {
      ...approvalEvidenceApplicationInclude.client.select,
      bankName: true,
      bankBranchCode: true,
      bankAccountNumber: true,
      accountType: true,
    },
  },
} as const

/**
 * The three collections `readCompositeKycState` reads, as this module selects
 * them. Declared as `Prisma.validator` selects rather than inline objects so
 * the in-memory rows carry the SAME types the real reader hands back — the
 * first cut typed them `Record<string, unknown>`, which made the cast to
 * `CompositeKycReader` a promise the compiler could not check.
 */
export const readinessCoreDocumentSelect =
  Prisma.validator<Prisma.ClientDocumentSelect>()({
    clientId: true,
    docType: true,
    verified: true,
    verificationNote: true,
    verificationRejectedById: true,
    verificationRejectedAt: true,
    id: true,
    contentSha256: true,
    createdAt: true,
  })

export const readinessSelfieSelect = Prisma.validator<Prisma.ClientDocumentSelect>()({
  clientId: true,
  id: true,
  contentSha256: true,
  deletedAt: true,
  verified: true,
  extractionStatus: true,
  extractionResult: true,
  extractionError: true,
  validationMismatch: true,
  validationScore: true,
  biometricMatchScore: true,
  biometricLiveness: true,
  biometricVerifiedAt: true,
  biometricResult: true,
})

export const readinessExceptionSelect =
  Prisma.validator<Prisma.ComplianceRecordSelect>()({
    id: true,
    referenceId: true,
    completedAt: true,
    data: true,
  })

export type ReadinessCoreDocumentRow = Prisma.ClientDocumentGetPayload<{
  select: typeof readinessCoreDocumentSelect
}>
export type ReadinessSelfieRow = Prisma.ClientDocumentGetPayload<{
  select: typeof readinessSelfieSelect
}>
export type ReadinessExceptionRow = Prisma.ComplianceRecordGetPayload<{
  select: typeof readinessExceptionSelect
}>

export interface ReadinessKycRows {
  coreDocuments: readonly ReadinessCoreDocumentRow[]
  /** Pre-sorted by `latestSelfieOrder()`; first match per client wins. */
  selfies: readonly ReadinessSelfieRow[]
  exceptions: readonly ReadinessExceptionRow[]
}

/**
 * A `CompositeKycReader` served from rows already in memory.
 *
 * The composite gate is the one piece of readiness that cannot be read off the
 * application row, and `readCompositeKycState` is the only correct way to
 * derive it — it is what /review, /decide and /disburse each call. Calling it
 * per card would be four queries per card. So the three collections it reads
 * are fetched ONCE for every client on the board, and this hands each
 * evaluation its own client's slice.
 *
 * The two selfie reads are told apart by `orderBy`, which only the
 * latest-selfie call carries, and the blocking predicate is
 * `matchesBlockingSelfie` — the exported companion to the `where` clause the
 * real reader sends, so this cannot drift from it. `readiness-data.test.ts`
 * pins both against `readCompositeKycState`.
 *
 * The linear scan per card is O(cards x documents). Accepted: the board holds
 * a few dozen applications and four core documents apiece. If it ever
 * grows, group the rows by clientId once instead of filtering per card.
 */
export function inMemoryKycReader(
  clientId: string,
  data: ReadinessKycRows,
): CompositeKycReader {
  const forClient = <T extends { clientId: string | null }>(rows: readonly T[]) =>
    rows.filter((row) => row.clientId === clientId)

  const reader: CompositeKycReader = {
    clientDocument: {
      // The core-document read and the ID-portrait refusal read are told
      // apart by docType: only the refusal read asks for SELFIE rows.
      findMany: (async (args: { where: { docType?: unknown } }) => {
        if (args.where.docType !== "SELFIE") return forClient(data.coreDocuments)
        return forClient(data.selfies).filter(matchesIdPortraitRefusal)
      }) as CompositeKycReader["clientDocument"]["findMany"],
      findFirst: (async (args: { orderBy?: unknown }) => {
        const selfies = forClient(data.selfies)
        // The latest-selfie read carries an orderBy; the blocking-selfie read
        // does not. That is the only difference between the two call shapes,
        // and the reader interface's two overloads are what encode it.
        if (args.orderBy) return selfies[0] ?? null
        return selfies.find(matchesBlockingSelfie) ?? null
      }) as CompositeKycReader["clientDocument"]["findFirst"],
    },
    complianceRecord: {
      findFirst: async () =>
        data.exceptions.find((record) => record.referenceId === clientId) ?? null,
    },
  }
  return reader
}

/**
 * Readiness for every board application that draws a chip, keyed by id.
 *
 * Six queries for the whole board, whatever its size — never one per card.
 */
export async function readApplicationReadiness(
  tenantId: string,
): Promise<Map<string, ApplicationReadiness>> {
  const applications = await prisma.loanApplication.findMany({
    where: { tenantId, status: { in: [...READINESS_STATUSES] } },
    select: readinessApplicationSelect,
  })
  if (applications.length === 0) return new Map()

  const clientIds = [...new Set(applications.map((app) => app.clientId))]
  const applicationIds = applications.map((app) => app.id)

  const [coreDocuments, selfies, exceptions, bureauChecks, tenantConfig, mismatches] =
    await Promise.all([
      prisma.clientDocument.findMany({
        where: {
          tenantId,
          clientId: { in: clientIds },
          deletedAt: null,
          docType: { in: [...CORE_KYC_DOCUMENT_TYPES] },
        },
        select: readinessCoreDocumentSelect,
      }),
      prisma.clientDocument.findMany({
        // Every selfie, not only the blocking ones: `readCompositeKycState`
        // reads the LATEST attempt whatever its state, and separately asks
        // whether ANY blocking one exists. Both are served from this one list.
        where: { tenantId, clientId: { in: clientIds }, docType: "SELFIE" as const },
        orderBy: latestSelfieOrder(),
        select: readinessSelfieSelect,
      }),
      prisma.complianceRecord.findMany({
        where: {
          tenantId,
          type: "KYC_EXCEPTION",
          referenceId: { in: clientIds },
          status: "COMPLETED",
          completedAt: { not: null },
        },
        orderBy: [{ completedAt: "desc" }, { createdAt: "desc" }, { id: "desc" }],
        select: readinessExceptionSelect,
      }),
      // The approval gate's bureau read, batched: same generation binding,
      // same staleness cutoff, same provider.
      prisma.creditBureauCheck.findMany({
        where: {
          tenantId,
          applicationId: { in: applicationIds },
          ok: true,
          createdAt: { gte: bureauStalenessCutoff() },
          provider: "experian",
        },
        orderBy: { createdAt: "desc" },
        select: readinessBureauSelect,
      }),
      prisma.tenantConfig.findFirst({
        where: { tenantId },
        select: { bureauMinScore: true, bureauBlockAdverse: true, ndiBufferPct: true },
      }),
      prisma.clientDocument.groupBy({
        by: ["clientId"],
        where: unresolvedNonBiometricDocumentMismatchWhere({
          tenantId,
          clientId: { in: clientIds },
        }),
        _count: { _all: true },
      }),
    ])

  return assembleReadiness({
    tenantId,
    applications,
    kycRows: { coreDocuments, selfies, exceptions },
    bureauChecks,
    tenantConfig,
    mismatches,
    now: new Date(),
  })
}

export const readinessBureauSelect =
  Prisma.validator<Prisma.CreditBureauCheckSelect>()({
    id: true,
    clientId: true,
    provider: true,
    createdAt: true,
    subjectFingerprint: true,
    riskGrade: true,
    obligations: true,
    applicationId: true,
    reviewGeneration: true,
    score: true,
    unscoreable: true,
    hasAdverse: true,
    deceased: true,
    underDebtReview: true,
    hasJudgement: true,
    hasNotice: true,
  })

export type ReadinessBureauRow = Prisma.CreditBureauCheckGetPayload<{
  select: typeof readinessBureauSelect
}>

/**
 * Everything the queries above feed into `computeReadiness`, as one pure
 * function of its inputs.
 *
 * Split out so the fan-out is testable without a database: the joins here —
 * which bureau row belongs to which application, which mismatch count to which
 * client, what a tenant with no config row falls back to — are the parts that
 * can silently give every card the wrong answer, and mocking Prisma to reach
 * them would test the mock.
 */
export async function assembleReadiness(args: {
  tenantId: string
  applications: readonly LoadedApplication[]
  kycRows: ReadinessKycRows
  bureauChecks: readonly ReadinessBureauRow[]
  tenantConfig: {
    bureauMinScore: number
    bureauBlockAdverse: boolean
    ndiBufferPct: number
  } | null
  mismatches: readonly { clientId: string; _count: { _all: number } }[]
  /**
   * One clock for the whole board: the contract-expiry leg is time-dependent
   * and two cards in one paint must not disagree about it.
   */
  now: Date
}): Promise<Map<string, ApplicationReadiness>> {
  const { tenantId, applications, kycRows, bureauChecks, tenantConfig, mismatches, now } = args
  const mismatchByClient = new Map(
    mismatches.map((row) => [row.clientId, row._count._all]),
  )
  // The same fallbacks /decide applies when a tenant has no config row.
  const bureauPolicy = {
    bureauMinScore: tenantConfig?.bureauMinScore ?? 450,
    bureauBlockAdverse: tenantConfig?.bureauBlockAdverse ?? false,
  }
  const readiness = new Map<string, ApplicationReadiness>()
  for (const application of applications) {
    const kyc = await readCompositeKycState(
      inMemoryKycReader(application.clientId, kycRows),
      {
        tenantId,
        clientId: application.clientId,
        subject: application.client,
        existing: application.client,
        preserveVerifiedProvenance: true,
      },
    )
    // `bureauReviewGeneration` binds the check to the CURRENT review; a check
    // from an earlier generation is not a current assessment. Null generation
    // means no review has run, so no check can qualify — exactly what
    // /decide does by not querying at all.
    const bureau =
      application.bureauReviewGeneration === null
        ? null
        : bureauChecks.find(
            (check) =>
              check.applicationId === application.id
              && check.reviewGeneration === application.bureauReviewGeneration,
          ) ?? null

    const result = computeReadiness({
      application: toReadinessApplication(application),
      kyc,
      documentMismatchCount: mismatchByClient.get(application.clientId) ?? 0,
      bureau,
      bureauPolicy,
      bureauEvidenceCheck: bureau,
      tenantConfig: tenantConfig
        ? { ...tenantConfig, ndiBufferPct: tenantConfig.ndiBufferPct }
        : null,
      now,
    })
    if (result) readiness.set(application.id, result)
  }
  return readiness
}

type LoadedApplication = Prisma.LoanApplicationGetPayload<{
  select: typeof readinessApplicationSelect
}>

function toReadinessApplication(app: LoadedApplication): ReadinessApplication {
  return {
    status: app.status,
    submittedAt: app.submittedAt,
    appliedAmount: app.appliedAmount,
    appliedTermDays: app.appliedTermDays,
    affordabilityResult: app.affordabilityResult,
    clientAffordabilityDeclaredAt: app.clientAffordabilityDeclaredAt,
    recklessLendingAssessed: app.recklessLendingAssessed,
    recklessLendingAssessedAt: app.recklessLendingAssessedAt,
    recklessLendingAssessedById: app.recklessLendingAssessedById,
    repaymentMethod: app.repaymentMethod,
    agreementSignedAt: app.agreementSignedAt,
    agreementDocumentId: app.agreementDocumentId,
    agreementDocumentSha256: app.agreementDocumentSha256,
    creditLife: app,
    countersign: app,
    mandate: app,
    client: app.client,
    disbursementEvidence: app,
  }
}
