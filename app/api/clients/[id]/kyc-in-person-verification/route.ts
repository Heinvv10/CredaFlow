import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"
import { Prisma } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { lockAffordabilityClientEvidence } from "@/lib/affordability/evidence-locks"
import { AuditAction } from "@/lib/audit"
import { biometricSubjectFingerprint } from "@/lib/kyc/biometric-evidence"
import {
  CORE_KYC_DOCUMENT_TYPES,
  clientKycAuditValue,
  latestSelfieOrder,
} from "@/lib/kyc/document-state"
import {
  BLOCKING_SELFIE_CONDITIONS,
  IN_PERSON_KYC_VERIFICATION_KIND,
  IN_PERSON_KYC_VERIFICATION_MIN_NOTE_CHARACTERS,
  IN_PERSON_KYC_VERIFICATION_VERSION,
  ID_PORTRAIT_REFUSAL_CONDITIONS,
  idDocumentPortraitRefused,
  isInPersonKycVerificationMethod,
  selfieBlocksInPersonVerification,
  type InPersonKycVerificationEvidence,
} from "@/lib/kyc/in-person-verification"
import {
  hasMinimumManualKycExceptionCharacters,
  normalizeManualKycExceptionText,
} from "@/lib/kyc/manual-exception-policy"
import { selectUsableIdDocument } from "@/lib/kyc/usable-id-document"

/**
 * Record an in-person identity verification where no biometric was captured.
 *
 * This is not a way to skip the selfie. It substitutes one form of evidence for
 * another: a named senior staff member attesting they compared the applicant to
 * the ID document. The attestation is bound to that exact ID and identity, so it
 * lapses the moment either changes — see lib/kyc/in-person-verification.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    // Same authority floor as the senior biometric exception: a credit officer
    // or loan admin may not substitute their own word for a biometric.
    const guard = await requireApiRole("ADMIN")
    if (guard.error) return guard.error

    const body = (await req.json().catch(() => null)) as
      | { method?: unknown; note?: unknown }
      | null
    if (!isInPersonKycVerificationMethod(body?.method)) {
      return NextResponse.json(
        { error: "Select how the client's identity was verified." },
        { status: 400 },
      )
    }
    const method = body.method
    const note = typeof body?.note === "string"
      ? normalizeManualKycExceptionText(body.note)
      : ""
    if (
      !hasMinimumManualKycExceptionCharacters(
        note,
        IN_PERSON_KYC_VERIFICATION_MIN_NOTE_CHARACTERS,
      )
    ) {
      return NextResponse.json(
        {
          error: `Describe what was verified in at least ${IN_PERSON_KYC_VERIFICATION_MIN_NOTE_CHARACTERS} characters.`,
        },
        { status: 400 },
      )
    }

    return await withTenantContext(req, async (tenant) => {
      const { id: clientId } = await params
      const outcome = await prisma.$transaction(async (tx) => {
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

        const [coreDocuments, blockingCandidates, portraitRefusals, latestAttempt] = await Promise.all([
          tx.clientDocument.findMany({
            where: {
              tenantId: tenant.id,
              clientId,
              deletedAt: null,
              docType: { in: [...CORE_KYC_DOCUMENT_TYPES] },
            },
            // createdAt is selected because selectUsableIdDocument prefers the
            // most recent usable copy; without it the choice among several
            // would fall back to the database's arbitrary order.
            select: {
              id: true,
              docType: true,
              verified: true,
              contentSha256: true,
              createdAt: true,
              // Whether a passed selfie's ID copy still holds it in scope.
              verificationRejectedAt: true,
              verificationRejectedById: true,
            },
            orderBy: { createdAt: "desc" },
          }),
          tx.clientDocument.findMany({
            where: { tenantId: tenant.id, clientId, ...BLOCKING_SELFIE_CONDITIONS },
            select: { extractionStatus: true, biometricResult: true, createdAt: true },
          }),
          // Every attempt, deleted or not, that refused an ID portrait.
          tx.clientDocument.findMany({
            where: { tenantId: tenant.id, clientId, ...ID_PORTRAIT_REFUSAL_CONDITIONS },
            select: { biometricResult: true },
          }),
          // The newest attempt of any outcome, part of the circumstances attested to.
          tx.clientDocument.findFirst({
            where: { tenantId: tenant.id, clientId, docType: "SELFIE" },
            orderBy: latestSelfieOrder(),
            select: { id: true },
          }),
        ])

        const verifiedCore = new Set(
          coreDocuments.filter((d) => d.verified).map((d) => d.docType),
        )
        const missingDocs = CORE_KYC_DOCUMENT_TYPES.filter(
          (docType) => !verifiedCore.has(docType),
        )
        if (missingDocs.length > 0) {
          return { kind: "core_documents_missing" as const, missingDocs }
        }

        // Only a LIVE biometric candidate takes this route out of scope: an
        // attempt still processing, or one whose provider-verified evidence
        // passed against an ID copy still on file and not rejected. A failed
        // or soft-deleted attempt must not close the human fallback; the
        // senior exception remains available in parallel for the failed
        // evidence.
        // Judged against the attestation this writes: completed now, after
        // every attempt on file, by staff who can see them.
        const approvedAt = new Date()
        const idDocumentCopies = coreDocuments.filter((d) => d.docType === "ID_COPY")
        if (blockingCandidates.some((selfie) =>
          selfieBlocksInPersonVerification(selfie, idDocumentCopies, approvedAt))) {
          return { kind: "biometric_attempt_exists" as const }
        }

        // A client can hold several ID copies — a replacement upload adds a row
        // rather than superseding one. Taking `.find()` over an unordered
        // findMany took whichever row Postgres returned first, so a client whose
        // OLDEST copy predates content hashing was refused while two verified
        // copies with real digests sat on file, and could never be disbursed.
        const idDocument = selectUsableIdDocument(coreDocuments)
        if (!idDocument) {
          return { kind: "id_document_unusable" as const }
        }
        if (idDocumentPortraitRefused(portraitRefusals, idDocument)) {
          return { kind: "id_document_portrait_invalid" as const }
        }

        const subjectFingerprint = biometricSubjectFingerprint(client)
        const evidence: InPersonKycVerificationEvidence = {
          kind: IN_PERSON_KYC_VERIFICATION_KIND,
          version: IN_PERSON_KYC_VERIFICATION_VERSION,
          clientId,
          idDocumentId: idDocument.id,
          idDocumentSha256: idDocument.contentSha256,
          subjectFingerprint,
          method,
          note,
          approvedAt: approvedAt.toISOString(),
          approvedById: guard.user.id,
          approvedByEmail: guard.user.email,
        }
        // Keyed to the exact circumstances attested to, so the same admin
        // cannot stack duplicate attestations over one identity + ID pair.
        // The newest selfie attempt is one of those circumstances: an
        // attestation from before a later attempt no longer counts once that
        // attempt is released (selfieBlocksInPersonVerification), so staff
        // must be able to attest afresh after it.
        const idempotencyKey = [
          "kyc-in-person",
          clientId,
          idDocument.id,
          idDocument.contentSha256,
          subjectFingerprint,
          latestAttempt?.id ?? "no-selfie",
        ].join(":")
        const existing = await tx.complianceRecord.findUnique({
          where: { idempotencyKey },
          select: { id: true },
        })
        if (existing) {
          return { kind: "verification_exists" as const, recordId: existing.id }
        }

        const record = await tx.complianceRecord.create({
          data: {
            tenantId: tenant.id,
            // Deliberately the same compliance type as the senior biometric
            // exception: both are KYC exceptions and a compliance report should
            // count them together. The data.kind discriminates them, and the
            // two states are mutually exclusive (this one requires no selfie).
            type: "KYC_EXCEPTION",
            referenceId: clientId,
            idempotencyKey,
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
            // Never BIOMETRIC or SMILE_IDENTITY — no biometric was performed.
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
            action: AuditAction.KYC_IN_PERSON_VERIFICATION_GRANTED,
            entity: "Client",
            entityId: clientId,
            oldValue: {
              clientKyc: clientKycAuditValue(client),
              biometricEvidence: "biometric_evidence_missing",
            },
            newValue: {
              clientKyc: clientKycAuditValue(updatedClient),
              complianceRecordId: record.id,
              inPersonVerification: true,
              biometricVerified: false,
              evidence,
            },
          },
        })
        return {
          kind: "granted" as const,
          recordId: record.id,
          evidence,
          client: updatedClient,
        }
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })

      if (outcome.kind === "client_missing") {
        return NextResponse.json({ error: "Client not found" }, { status: 404 })
      }
      if (outcome.kind === "manual_rejection_active") {
        return NextResponse.json(
          { error: "Resolve the active manual KYC rejection before recording an in-person verification." },
          { status: 409 },
        )
      }
      if (outcome.kind === "core_documents_missing") {
        return NextResponse.json(
          {
            error: "All four core documents must be verified before recording an in-person verification.",
            missingDocs: outcome.missingDocs,
          },
          { status: 422 },
        )
      }
      if (outcome.kind === "biometric_attempt_exists") {
        return NextResponse.json(
          {
            error: "A biometric attempt is still processing or has already passed for this client, so the biometric result governs and an in-person verification cannot replace it.",
          },
          { status: 409 },
        )
      }
      if (outcome.kind === "id_document_unusable") {
        return NextResponse.json(
          {
            error: "A verified ID document with intact stored content is required to record an in-person verification.",
          },
          { status: 422 },
        )
      }
      if (outcome.kind === "id_document_portrait_invalid") {
        return NextResponse.json(
          {
            error: "A selfie check found no real photograph on this ID document, so an in-person verification cannot be recorded against it. A new, clear photo of the client's ID must be uploaded and verified first.",
          },
          { status: 422 },
        )
      }
      if (outcome.kind === "verification_exists") {
        return NextResponse.json(
          {
            error: "An in-person verification already exists for this identity and ID document.",
          },
          { status: 409 },
        )
      }

      return NextResponse.json({
        ok: true,
        complianceRecordId: outcome.recordId,
        verification: outcome.evidence,
        client: outcome.client,
      })
    })
  } catch (error) {
    // P2002 = the idempotency key was taken concurrently; P2034 = serialization
    // conflict. Both mean another writer moved the evidence under us.
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      (error.code === "P2002" || error.code === "P2034")
    ) {
      return NextResponse.json(
        {
          error: "The KYC evidence changed or a verification was recorded concurrently. Refresh and review the current state.",
        },
        { status: 409 },
      )
    }
    console.error("Failed to record in-person KYC verification:", error)
    return NextResponse.json(
      { error: "Could not record the in-person verification." },
      { status: 500 },
    )
  }
}
