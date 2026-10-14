import type { prisma } from "@/lib/prisma"
import { PRIOR_FAILED_ATTEMPT_CONDITIONS, type BiometricSubjectClient } from "@/lib/kyc/biometric-evidence"
import {
  currentInPersonKycVerification,
  selfieBlocksInPersonVerification,
  type InPersonKycVerificationEvidence,
  type InPersonKycVerificationRecord,
} from "@/lib/kyc/in-person-verification"

type Reader = Pick<typeof prisma, "complianceRecord" | "clientDocument">

/**
 * The in-person attestation that STANDS for this client right now, if any.
 *
 * The idempotency key (inPersonAttestationIdempotencyKey) names the latest
 * attempt and its verdict stamp, so it changes when a late answer is recorded on
 * that attempt even though the attestation is untouched (a verdict about a
 * superseded ID copy does not lapse it). Keyed alone, a second identical
 * attestation would then be accepted while the first is valid. Both grant
 * routes ask this first and refuse.
 */
export async function findStandingInPersonAttestation(
  tx: Reader,
  args: {
    tenantId: string
    clientId: string
    subject: BiometricSubjectClient
    idDocument: { id: string; contentSha256: string | null }
    portraitRefusals: readonly { biometricResult: unknown }[]
    /** The blocking-selfie candidates and ID copies the route already read. */
    blockingCandidates: readonly { extractionStatus: string | null; biometricResult: unknown; createdAt: Date }[]
    idDocumentCopies: Parameters<typeof selfieBlocksInPersonVerification>[1]
  },
): Promise<InPersonKycVerificationEvidence | null> {
  const [record, attempts] = await Promise.all([
    tx.complianceRecord.findFirst({
      where: {
        tenantId: args.tenantId, type: "KYC_EXCEPTION", referenceId: args.clientId,
        status: "COMPLETED", completedAt: { not: null },
      },
      orderBy: [{ completedAt: "desc" }, { createdAt: "desc" }, { id: "desc" }],
      select: { id: true, completedAt: true, data: true },
    }),
    tx.clientDocument.findMany({
      where: { tenantId: args.tenantId, clientId: args.clientId, ...PRIOR_FAILED_ATTEMPT_CONDITIONS },
      select: { biometricResult: true, createdAt: true, deletedAt: true, extractionStatus: true },
    }),
  ])
  // Judged against the attestation ON FILE, as readCompositeKycState does: a
  // passed selfie that followed it still governs, whatever the route would
  // judge for an attestation written now.
  const blocksAttestationOnFile = args.blockingCandidates.some((selfie) =>
    selfieBlocksInPersonVerification(selfie, args.idDocumentCopies, record?.completedAt ?? null))
  return currentInPersonKycVerification(record as InPersonKycVerificationRecord | null, {
    clientId: args.clientId,
    subject: args.subject,
    idDocument: { ...args.idDocument, deletedAt: null, verified: true },
    blockingBiometricAttempt: blocksAttestationOnFile,
    biometricAssessment: { ok: false, reason: "biometric_evidence_missing" },
    portraitRefusals: args.portraitRefusals,
    selfieAttempts: attempts,
  })
}
