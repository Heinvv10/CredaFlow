import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"
import { Prisma } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { lockAffordabilityClientEvidence } from "@/lib/affordability/evidence-locks"
import { AuditAction } from "@/lib/audit"
import {
  assessBiometricEvidence,
  biometricSubjectFingerprint,
} from "@/lib/kyc/biometric-evidence"
import {
  CORE_KYC_DOCUMENT_TYPES,
  clientKycAuditValue,
  latestSelfieOrder,
} from "@/lib/kyc/document-state"
import { outstandingCoreDocuments } from "@/lib/kyc/id-replacement"
import {
  MANUAL_KYC_EXCEPTION_KIND,
  MANUAL_KYC_EXCEPTION_VERSION,
  currentManualKycException,
  type ManualKycExceptionEvidence,
} from "@/lib/kyc/manual-exception"
import {
  MANUAL_KYC_EXCEPTION_MIN_EVIDENCE_CHARACTERS,
  MANUAL_KYC_EXCEPTION_MIN_REASON_CHARACTERS,
  hasMinimumManualKycExceptionCharacters,
  isManualKycExceptionableAttempt,
  normalizeManualKycExceptionText,
} from "@/lib/kyc/manual-exception-policy"
import { isSha256Digest } from "@/lib/documents/content-integrity"
import {
  getLockedKycOverridePolicy,
  overrideEligibility,
  readFaceModelSimilarity,
  readFaceVerdict,
  type KycOverrideRefusalCode,
} from "@/lib/kyc/override-policy"

function policyRefusal(code: KycOverrideRefusalCode) {
  const messages: Record<KycOverrideRefusalCode, string> = {
    clear_mismatch: "Faces clearly don't match — this can't be overridden. Ask the client for a new selfie, or verify them in person.",
    never_exceptionable: "This biometric failure cannot be overridden. Capture a new selfie against the current identity.",
    overrides_disabled: "KYC overrides are disabled for this lender.",
    role_below_policy: "Your role is below this lender's minimum role for KYC overrides.",
    totp_required: "Sign in with two-factor authentication before performing a KYC override.",
    second_approver_required: "This lender requires a different senior to approve the override request.",
  }
  const status = code === "second_approver_required" ? 409 : code === "clear_mismatch" || code === "never_exceptionable" ? 422 : 403
  return NextResponse.json({ error: messages[code], code }, { status })
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    // This is deliberately above ordinary origination authority. A credit
    // officer or loan admin may not turn a failed liveness result into a
    // payout-eligible KYC state.
    const guard = await requireApiRole("BRANCH_MANAGER")
    if (guard.error) return guard.error

    const body = (await req.json().catch(() => null)) as
      | { reason?: unknown; supportingEvidence?: unknown }
      | null
    const reason = typeof body?.reason === "string"
      ? normalizeManualKycExceptionText(body.reason)
      : ""
    const supportingEvidence =
      typeof body?.supportingEvidence === "string"
        ? normalizeManualKycExceptionText(body.supportingEvidence)
        : ""
    if (
      !hasMinimumManualKycExceptionCharacters(
        reason,
        MANUAL_KYC_EXCEPTION_MIN_REASON_CHARACTERS,
      )
    ) {
      return NextResponse.json(
        {
          error: `Exception reason must be at least ${MANUAL_KYC_EXCEPTION_MIN_REASON_CHARACTERS} characters.`,
        },
        { status: 400 },
      )
    }
    if (
      !hasMinimumManualKycExceptionCharacters(
        supportingEvidence,
        MANUAL_KYC_EXCEPTION_MIN_EVIDENCE_CHARACTERS,
      )
    ) {
      return NextResponse.json(
        {
          error: `Supporting evidence must be at least ${MANUAL_KYC_EXCEPTION_MIN_EVIDENCE_CHARACTERS} characters.`,
        },
        { status: 400 },
      )
    }

    return await withTenantContext(req, async (tenant) => {
      const { id: clientId } = await params
      const outcome = await prisma.$transaction(async (tx) => {
        const policy = await getLockedKycOverridePolicy(tx, tenant.id)
        await lockAffordabilityClientEvidence(tx, {
          tenantId: tenant.id,
          clientId,
        })
        const client = await tx.client.findUnique({
          where: { id: clientId, tenantId: tenant.id },
          select: {
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
          },
        })
        if (!client) return { kind: "client_missing" as const }
        if (client.kycManualRejectionActive) {
          return { kind: "manual_rejection_active" as const }
        }

        const [coreDocuments, latestSelfie, previousRecord] =
          await Promise.all([
            tx.clientDocument.findMany({
              where: {
                tenantId: tenant.id,
                clientId,
                deletedAt: null,
                docType: { in: [...CORE_KYC_DOCUMENT_TYPES] },
              },
              select: {
                id: true,
                docType: true,
                verified: true,
                verificationNote: true,
                createdAt: true,
                verificationRejectedAt: true,
                verificationRejectedById: true,
              },
            }),
            tx.clientDocument.findFirst({
              where: {
                tenantId: tenant.id,
                clientId,
                docType: "SELFIE",
              },
              orderBy: latestSelfieOrder(),
              select: {
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
              },
            }),
            tx.complianceRecord.findFirst({
              where: {
                tenantId: tenant.id,
                type: "KYC_EXCEPTION",
                referenceId: clientId,
                status: "COMPLETED",
                completedAt: { not: null },
              },
              orderBy: [
                { completedAt: "desc" },
                { createdAt: "desc" },
                { id: "desc" },
              ],
              select: { id: true, completedAt: true, data: true },
            }),
          ])

        const missingDocs = outstandingCoreDocuments(
          CORE_KYC_DOCUMENT_TYPES,
          coreDocuments,
        )
        if (missingDocs.length > 0) {
          return { kind: "core_documents_missing" as const, missingDocs }
        }
        if (
          !latestSelfie ||
          latestSelfie.deletedAt !== null ||
          !isSha256Digest(latestSelfie.contentSha256)
        ) {
          return { kind: "selfie_integrity_missing" as const }
        }
        if (
          latestSelfie.extractionStatus === "pending" ||
          latestSelfie.extractionStatus === "processing"
        ) {
          return { kind: "selfie_processing" as const }
        }

        // The ID copy subject_has_composite_kyc binds the match to.
        const idDocument = await tx.clientDocument.findFirst({
          where: {
            tenantId: tenant.id,
            clientId,
            docType: "ID_COPY",
            deletedAt: null,
            verified: true,
          },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          select: { id: true, contentSha256: true },
        })
        const biometricAssessment = assessBiometricEvidence(latestSelfie, {
          subject: client,
          idDocument,
          // Only the refusal reason is read here, which this never changes.
          idDocumentCopies: null,
          requireDocumentVerified: false,
        })
        if (biometricAssessment.ok) {
          return { kind: "biometric_already_valid" as const }
        }
        if (
          !isManualKycExceptionableAttempt({
            extractionStatus: latestSelfie.extractionStatus,
            biometricFailureReason: biometricAssessment.reason,
          })
        ) {
          return {
            kind: "failure_not_exceptionable" as const,
            biometricEvidence: biometricAssessment.reason,
          }
        }
        const eligibility = overrideEligibility({
          kind: "EXCEPTION",
          mode: "direct",
          attempt: {
            extractionStatus: latestSelfie.extractionStatus,
            biometricFailureReason: biometricAssessment.reason,
            similarity: readFaceModelSimilarity(latestSelfie.biometricResult),
            faceVerdict: readFaceVerdict(latestSelfie.biometricResult),
          },
          policy,
          caller: { role: guard.user.role, totpVerified: guard.user.totpVerified === true },
        })
        if (!eligibility.allowed) return { kind: "policy_refused" as const, code: eligibility.code }
        const previousException = currentManualKycException(previousRecord, {
          clientId,
          subject: client,
          latestSelfie,
          biometricAssessment,
        })
        if (previousException) {
          return {
            kind: "exception_exists" as const,
            exception: previousException,
          }
        }

        const approvedAt = new Date()
        const evidence: ManualKycExceptionEvidence = {
          kind: MANUAL_KYC_EXCEPTION_KIND,
          version: MANUAL_KYC_EXCEPTION_VERSION,
          clientId,
          documentId: latestSelfie.id,
          documentSha256: latestSelfie.contentSha256,
          subjectFingerprint: biometricSubjectFingerprint(client),
          biometricFailureReason: biometricAssessment.reason,
          reason,
          supportingEvidence,
          approvedAt: approvedAt.toISOString(),
          approvedById: guard.user.id,
          approvedByEmail: guard.user.email,
          approvedWithTotp: guard.user.totpVerified === true,
        }
        const exceptionRecord = await tx.complianceRecord.create({
          data: {
            tenantId: tenant.id,
            type: "KYC_EXCEPTION",
            referenceId: clientId,
            idempotencyKey: [
              "kyc-exception",
              clientId,
              latestSelfie.id,
              latestSelfie.contentSha256,
            ].join(":"),
            status: "COMPLETED",
            completedAt: approvedAt,
            data: evidence as unknown as Prisma.InputJsonValue,
          },
          select: { id: true },
        })
        const updatedClient = await tx.client.update({
          where: { id: clientId, tenantId: tenant.id },
          data: {
            kycStatus: "VERIFIED",
            kycVerifiedAt: approvedAt,
            kycVerifiedById: guard.user.id,
            // Manual exception is intentionally not labelled BIOMETRIC or
            // SMILE_IDENTITY. The separate compliance record is authoritative.
            kycVerificationMethod: "PHYSICAL",
          },
          select: {
            kycStatus: true,
            kycVerifiedAt: true,
            kycVerifiedById: true,
            kycVerificationMethod: true,
          },
        })
        await tx.auditLog.create({
          data: {
            tenantId: tenant.id,
            userId: guard.user.id,
            userEmail: guard.user.email,
            action: AuditAction.KYC_EXCEPTION_GRANTED,
            entity: "Client",
            entityId: clientId,
            oldValue: {
              clientKyc: clientKycAuditValue(client),
              latestSelfieId: latestSelfie.id,
              latestSelfieSha256: latestSelfie.contentSha256,
              biometricEvidence: biometricAssessment.reason,
            },
            newValue: {
              clientKyc: clientKycAuditValue(updatedClient),
              exceptionRecordId: exceptionRecord.id,
              manualException: true,
              biometricVerified: false,
              evidence,
            },
          },
        })
        await tx.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE")
        return {
          kind: "granted" as const,
          exceptionRecordId: exceptionRecord.id,
          evidence,
          client: updatedClient,
        }
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })

      if (outcome.kind === "client_missing") {
        return NextResponse.json({ error: "Client not found" }, { status: 404 })
      }
      if (outcome.kind === "manual_rejection_active") {
        return NextResponse.json(
          {
            error: "Resolve the active manual KYC rejection before granting an exception.",
          },
          { status: 409 },
        )
      }
      if (outcome.kind === "core_documents_missing") {
        return NextResponse.json(
          {
            error: "All four core KYC documents must be verified before a senior exception.",
            missingDocs: outcome.missingDocs,
          },
          { status: 422 },
        )
      }
      if (outcome.kind === "selfie_integrity_missing") {
        return NextResponse.json(
          {
            error: "The latest failed selfie is missing intact SHA-256-bound bytes. Capture a new selfie before exception review.",
          },
          { status: 422 },
        )
      }
      if (outcome.kind === "selfie_processing") {
        return NextResponse.json(
          { error: "Biometric verification is still processing." },
          { status: 409 },
        )
      }
      if (outcome.kind === "biometric_already_valid") {
        return NextResponse.json(
          {
            error: "The latest biometric attempt is already valid; no exception is required.",
          },
          { status: 409 },
        )
      }
      if (outcome.kind === "failure_not_exceptionable") {
        return NextResponse.json(
          {
            error: "This biometric failure cannot be overridden. Capture a new selfie against the current identity.",
            biometricEvidence: outcome.biometricEvidence,
          },
          { status: 422 },
        )
      }
      if (outcome.kind === "exception_exists") {
        return NextResponse.json(
          {
            error: "A current senior KYC exception already exists for this exact failed attempt.",
            exception: outcome.exception,
          },
          { status: 409 },
        )
      }
      if (outcome.kind === "policy_refused") return policyRefusal(outcome.code)

      return NextResponse.json({
        ok: true,
        kycStatus: outcome.client.kycStatus,
        kycVerificationMethod: outcome.client.kycVerificationMethod,
        exceptionRecordId: outcome.exceptionRecordId,
        manualException: outcome.evidence,
      }, { status: 201 })
    })
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      (error.code === "P2002" || error.code === "P2034")
    ) {
      return NextResponse.json(
        {
          error: "The KYC evidence changed or an exception was granted concurrently. Refresh and review the current attempt.",
        },
        { status: 409 },
      )
    }
    if (error instanceof Prisma.PrismaClientUnknownRequestError && error.message.includes("KYC override")) {
      return NextResponse.json({ error: "The lender policy or KYC evidence changed. Refresh and review the current attempt." }, { status: 409 })
    }
    console.error("Failed to grant KYC exception:", error)
    return NextResponse.json(
      { error: "Failed to grant KYC exception" },
      { status: 500 },
    )
  }
}
