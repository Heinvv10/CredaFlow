import { AuditAction, logAuditStrict } from "@/lib/audit"
import { lockAffordabilityClientEvidence } from "@/lib/affordability/evidence-locks"
import { prisma } from "@/lib/prisma"
import type { BiometricEvidenceFailureReason } from "@/lib/kyc/biometric-evidence"
import {
  clientKycAuditValue,
  readCompositeKycState,
  type CompositeKycReader,
} from "@/lib/kyc/document-state"

/**
 * Selfie attempts stuck in `processing`.
 *
 * captureSelfie claims an attempt as `processing` and runs the VLM face match
 * fire-and-forget. If that worker dies (deploy, OOM, crash) nothing ever
 * writes the verdict, so the row stays `processing` for good: it counts as an
 * adverse attempt (isAdversePriorAttempt) and closes the in-person route
 * (BLOCKING_SELFIE_CONDITIONS), and the client has no way forward.
 *
 * 15 minutes is the extraction lease the document extract route already uses
 * (EXTRACTION_LEASE_MS in app/api/documents/[id]/extract/route.ts). A live run
 * is bounded far below it: the VLM call aborts at 55 s and the face model at
 * 30 s, so a row older than the lease has no live worker behind it.
 */
export const SELFIE_PROCESSING_TIMEOUT_MS = 15 * 60 * 1000
/** Per tenant per run; the 5-minute schedule drains any backlog. */
const BATCH = 200

/**
 * The reason a swept attempt carries. Adverse in BIOMETRIC_FAILURE_REASON_CLASS
 * and not exceptionable, which is the honest reading: a judge may have
 * answered and the outcome was never recorded. extraction_incomplete is
 * benign and would launder a lost "different" into a capture problem.
 */
export const SWEPT_BIOMETRIC_FAILURE_REASON: BiometricEvidenceFailureReason =
  "biometric_outcome_not_recorded"

/**
 * A swept attempt, as persistBiometricOutcome recognises it: the only
 * non-`processing` row from which a worker's late answer is still accepted,
 * and only when that answer is adverse.
 */
export const SWEPT_ATTEMPT_CONDITIONS = {
  extractionStatus: "failed",
  verified: false,
  verificationRejectedAt: null,
  verificationRejectedById: null,
  biometricResult: { path: ["swept"], equals: true },
} as const

const CLIENT_KYC_SELECT = {
  id: true,
  idNumber: true,
  firstName: true,
  lastName: true,
  dateOfBirth: true,
  kycStatus: true,
  kycVerifiedAt: true,
  kycVerifiedById: true,
  kycVerificationMethod: true,
  kycManualRejectionActive: true,
  kycManualRejectionAt: true,
  kycManualRejectionById: true,
  kycManualRejectionReason: true,
  kycManualRejectionResolvedAt: true,
  kycManualRejectionResolvedById: true,
  kycManualRejectionResolutionReason: true,
} as const

function staleWhere(tenantId: string, now: Date) {
  const cutoff = new Date(now.getTime() - SELFIE_PROCESSING_TIMEOUT_MS)
  return {
    tenantId,
    docType: "SELFIE" as const,
    deletedAt: null,
    extractionStatus: "processing",
    verified: false,
    verificationNote: null,
    // extractionStartedAt is the lease clock; a row without one falls back to
    // its creation time rather than being skipped for ever.
    OR: [
      { extractionStartedAt: { lt: cutoff } },
      { extractionStartedAt: null, createdAt: { lt: cutoff } },
    ],
  }
}

/**
 * Fails one stale attempt, re-projects the client's KYC from the evidence and
 * audits both, in one transaction under the client evidence lock. The update
 * repeats the whole staleness rule and the generation that was read, so an
 * attempt whose worker finished (or was superseded) in between is left alone.
 */
export async function sweepStuckSelfie(
  tenantId: string,
  candidate: { id: string; clientId: string },
  now: Date,
): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    await lockAffordabilityClientEvidence(tx, { tenantId, clientId: candidate.clientId })

    const where = { ...staleWhere(tenantId, now), id: candidate.id, clientId: candidate.clientId }
    const attempt = await tx.clientDocument.findFirst({
      where,
      select: { id: true, extractionGeneration: true, extractionStartedAt: true },
    } as never) as unknown as {
      id: string
      extractionGeneration: string | null
      extractionStartedAt: Date | null
    } | null
    if (!attempt) return false

    const clientBefore = await tx.client.findUnique({
      where: { id: candidate.clientId, tenantId },
      select: CLIENT_KYC_SELECT,
    })
    if (!clientBefore) return false

    const extractionError = "Biometric verification did not complete and was timed out"
    const swept = await tx.clientDocument.updateMany({
      where: { ...where, extractionGeneration: attempt.extractionGeneration },
      data: {
        extractionStatus: "failed",
        extractionStartedAt: null,
        extractionError,
        validationMismatch: true,
        validationScore: 0,
        biometricMatchScore: null,
        biometricLiveness: null,
        biometricVerifiedAt: null,
        biometricResult: {
          biometricFailureReason: SWEPT_BIOMETRIC_FAILURE_REASON,
          swept: true,
          sweptAt: now.toISOString(),
        },
        verified: false,
        verifiedAt: null,
        verifiedById: null,
        verificationNote: extractionError,
      },
    } as never)
    if (swept.count !== 1) return false

    const composite = await readCompositeKycState(
      tx as unknown as CompositeKycReader,
      {
        tenantId,
        clientId: candidate.clientId,
        subject: clientBefore,
        existing: clientBefore,
        completion: { verifiedAt: now, verifiedById: null, method: "BIOMETRIC" },
      },
    )
    // An older attempt swept behind a newer selfie says nothing about the
    // client's current state, exactly as persistBiometricOutcome treats it.
    const latestSelfie = composite.latestSelfieId === candidate.id
    const clientAfter = latestSelfie
      ? await tx.client.update({
          where: { id: candidate.clientId, tenantId },
          data: composite.state,
          select: CLIENT_KYC_SELECT,
        })
      : clientBefore

    await logAuditStrict({
      tenantId,
      userEmail: "system@selfie-sweeper",
      action: AuditAction.KYC_REJECTED,
      entity: "ClientDocument",
      entityId: candidate.id,
      oldValue: {
        document: {
          extractionStatus: "processing",
          extractionGeneration: attempt.extractionGeneration,
          extractionStartedAt: attempt.extractionStartedAt?.toISOString() ?? null,
        },
        clientKyc: clientKycAuditValue(clientBefore),
      },
      newValue: {
        document: {
          verified: false,
          extractionStatus: "failed",
          extractionError,
          extractionGeneration: attempt.extractionGeneration,
          biometricFailureReason: SWEPT_BIOMETRIC_FAILURE_REASON,
          sweptAfterMs: SELFIE_PROCESSING_TIMEOUT_MS,
          latestSelfie,
        },
        clientKyc: clientKycAuditValue(clientAfter),
      },
    }, tx)
    return true
  })
}

/** Sweeps one tenant's stale selfie attempts; oldest first. */
export async function sweepStuckSelfies(tenantId: string, now: Date): Promise<{ swept: number }> {
  const stale = await prisma.clientDocument.findMany({
    where: staleWhere(tenantId, now),
    select: { id: true, clientId: true },
    orderBy: { createdAt: "asc" },
    take: BATCH,
  } as never) as unknown as Array<{ id: string; clientId: string }>
  let swept = 0
  for (const attempt of stale) if (await sweepStuckSelfie(tenantId, attempt, now)) swept++
  return { swept }
}
