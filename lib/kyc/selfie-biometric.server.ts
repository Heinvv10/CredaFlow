import { Prisma } from "@prisma/client"
import type { DocType } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { readFile } from "@/lib/storage"
import { extractDocumentData } from "@/lib/vlm-extract"
import { lockAffordabilityClientEvidence } from "@/lib/affordability/evidence-locks"
import { AuditAction } from "@/lib/audit"
import {
  clientKycAuditValue,
  latestSelfieOrder,
  readCompositeKycState,
  type ClientKycState,
  type CompositeKycReader,
} from "@/lib/kyc/document-state"
import {
  assessBiometricEvidence,
  assessVlmBiometricExtraction,
  biometricSubjectFingerprint,
  VLM_FACE_MATCH_PROVIDER,
  type BiometricEvidenceFailureReason,
} from "@/lib/kyc/biometric-evidence"
import {
  readVlmFaceMatchSideRejection,
  readVlmFaceMatchVerdict,
  type IdPhotoKind,
  type SamePersonVerdict,
  type VlmFaceMatchSideJudgement,
} from "@/lib/kyc/vlm-face-match"
import { isManualKycExceptionableFailureReason } from "@/lib/kyc/manual-exception-policy"
import { compareFaces, type FaceComparison } from "@/lib/kyc/face-model/compare.server"
import { canonicalBiometricImage } from "@/lib/kyc/biometric-image.server"
import type { FaceModelEvidence } from "@/lib/kyc/face-model/evidence"
import { isSha256Digest } from "@/lib/documents/content-integrity"

/**
 * The VLM liveness + face-match chain that runs after a selfie is stored.
 *
 * Moved here VERBATIM from app/api/documents/selfie/route.ts so the
 * authenticated route and the consumer link route run the identical pipeline.
 * Nothing in this file was "improved" during the move — a behaviour change
 * here is a KYC change, and the existing route suite is the proof it did not
 * happen.
 */
// The provider evidence written for every attempt. `assessBiometricEvidence`
// enforces ok/verified/matchScore/livenessScore/subjectFingerprint on this
// shape, so removing a field here closes the biometric path, never opens it.
type VlmFaceMatchProviderResult = {
  ok: boolean
  verified: boolean
  provider: typeof VLM_FACE_MATCH_PROVIDER
  matchScore: number
  livenessScore: number
  /** Raw 0–1 confidences; the thresholds are applied to these. */
  matchConfidence: number
  livenessConfidence: number
  faceMatch: boolean
  idPhotoFaceDetected: boolean
  /** What the VLM saw in the ID portrait area; only "photograph" can verify. */
  idPhotoKind: IdPhotoKind
  idPhotoIsRealPhotograph: boolean
  selfieIsRealPhotograph: boolean
  samePerson: SamePersonVerdict
  /**
   * The face model's comparison. It alone decides same-person: the VLM's own
   * samePerson/faceMatch/matchConfidence above can only refuse.
   */
  faceModel: FaceModelEvidence
  /** Which stored ID document the selfie was compared against. */
  idDocumentId: string
  idDocumentSha256: string | null
  error?: string
}

/** A strict refusal's side judgements when no provider result was written. */
type StrictRejectionJudgement = VlmFaceMatchSideJudgement & {
  provider: typeof VLM_FACE_MATCH_PROVIDER
  rejection: string
}

type IdDocumentReference = {
  id: string
  storagePath: string | null
  mimeType: string | null
  contentSha256: string | null
}

export async function runBiometricVerification(
  docId: string,
  clientId: string,
  tenantId: string,
  extractionGeneration: string,
  fileBuffer: Buffer,
  mimeType: string,
  idDocument: IdDocumentReference,
) {
  // INVARIANT for both persistBiometricOutcome calls below: whenever
  // `subjectFingerprint` is still null, `biometricFailureReason` must be
  // non-null and `biometricPassed` false. persistBiometricOutcome cannot bind
  // an attempt to a subject it never read, so it reports that reason verbatim;
  // a null reason alongside a null fingerprint would be the one shape that
  // could pass unbound. It defends itself with a fallback, but keep this end
  // honest too.
  let subjectFingerprint: string | null = null
  try {
    // Step A: the VLM is the biometric provider — one multimodal request
    // carrying the live selfie AND the stored ID document, returning
    // liveness evidence plus the face-match verdict.
    let idImage: { fileBuffer: Buffer; mimeType: string } | null = null
    let idImageError: string | null = null
    if (idDocument.storagePath) {
      try {
        idImage = {
          fileBuffer: await readFile(idDocument.storagePath),
          mimeType: idDocument.mimeType ?? "image/jpeg",
        }
      } catch {
        idImageError = "Stored ID document bytes are unavailable for the face match"
      }
    } else {
      idImageError = "Stored ID document has no retained bytes for the face match"
    }

    // Step A1: one canonical image per side (EXIF applied, flattened on
    // white, sRGB JPEG; a PDF rendered once), and both judges get exactly
    // those bytes. A side that cannot be prepared refuses the attempt as a
    // check that did not complete, before either judge runs: a decode or
    // render failure says nothing about the ID's photograph.
    const canonicalId = idImage ? await canonicalBiometricImage(idImage.fileBuffer, idImage.mimeType) : null
    const canonicalSelfie = await canonicalBiometricImage(fileBuffer, mimeType)
    const preparationRejection = canonicalId && !canonicalId.ok
      ? { reason: "extraction_incomplete" as const, message: `The ID document image could not be prepared for the identity check (${canonicalId.error})` }
      : !canonicalSelfie.ok
      ? { reason: "extraction_incomplete" as const, message: `The selfie image could not be prepared for the identity check (${canonicalSelfie.error})` }
      : null
    const images = canonicalId?.ok && canonicalSelfie.ok
      ? { id: canonicalId.image, selfie: canonicalSelfie.image }
      : null

    // Step A2: the face model (YuNet + SFace) compares the same two images
    // beside the VLM request. It never throws: every failure is a refusal.
    const [vlmResult, faceComparison] = await Promise.all([
      images
        ? extractDocumentData({
            fileBuffer: images.selfie.fileBuffer,
            mimeType: images.selfie.mimeType,
            docType: "SELFIE",
            referenceImage: images.id,
          })
        : Promise.resolve<Awaited<ReturnType<typeof extractDocumentData>>>({
            ok: false,
            error: preparationRejection?.message ?? idImageError ?? "ID document unavailable",
          }),
      images ? compareFaces(images.id, images.selfie) : Promise.resolve(null),
    ])

    const extractionUnavailable = !vlmResult.ok && vlmResult.error?.includes('AI document extraction is not configured')

    // Step B: bind the attempt to the exact subject identity on file
    const client = await prisma.client.findUnique({
      where: { id: clientId, tenantId },
      select: {
        idNumber: true,
        firstName: true,
        lastName: true,
        dateOfBirth: true,
      },
    })
    const subject = client
      ? {
          id: clientId,
          idNumber: client.idNumber,
          firstName: client.firstName,
          lastName: client.lastName,
          dateOfBirth: client.dateOfBirth,
        }
      : null
    subjectFingerprint = subject ? biometricSubjectFingerprint(subject) : null

    // Step C: derive the provider result from the VLM's own verdict. There is
    // no external provider any more (Smile Identity was never configured and
    // only ever returned simulated literals, which the KYC gate rejects). A
    // missing or malformed verdict yields NO provider evidence — fail closed.
    // With the VLM unconfigured there is no biometric provider at all: the
    // attempt fails and the in-person route remains the fallback.
    const extractionResult = extractionUnavailable
      ? { vlmUnavailable: true }
      : vlmResult.data ?? null
    const vlmAssessment = assessVlmBiometricExtraction(extractionResult)
    // Read the verdict even when the selfie side already failed: the ID-side
    // judgement must still be able to name a reason no human may except.
    const matchVerdict = extractionUnavailable
      ? null
      : readVlmFaceMatchVerdict(extractionResult)
    const modelRejection = faceComparison?.rejection ?? null
    // A refusal that can never be excepted (ID portrait or selfie not a real
    // photograph). It outranks every other failure, whichever side failed
    // first: a liveness or face-count failure is exceptionable, and recording
    // it instead let a senior except a match against a silhouette ID. When
    // the full verdict is unreadable (any one malformed field) or names only
    // an exceptionable refusal, the side judgements are read on their own.
    // The side reader refuses on exactly the fields the strict verdict's
    // non-exceptionable refusals read, so it also supplies their judgements.
    // The face model's own strict refusals (no usable ID face, the model
    // unavailable) come after the VLM's.
    const sideRejection = extractionUnavailable
      ? null
      : readVlmFaceMatchSideRejection(extractionResult)
    const strictRejection = preparationRejection ?? (matchVerdict?.rejection &&
      !isManualKycExceptionableFailureReason(matchVerdict.rejection.reason)
      ? matchVerdict.rejection
      : sideRejection)
      ?? (modelRejection && !isManualKycExceptionableFailureReason(modelRejection.reason)
        ? modelRejection
        : null)
    let biometricResult: VlmFaceMatchProviderResult | null = null
    if (vlmAssessment.ok && matchVerdict && client?.idNumber && faceComparison?.ok) {
      const refusal = strictRejection ?? modelRejection ?? matchVerdict.rejection
      biometricResult = {
        ok: true,
        // Every VLM gate in readVlmFaceMatchVerdict AND the face model must
        // hold. faceMatch alone once verified a selfie against a silhouette
        // placeholder, and the VLM's "same" cannot outvote the model.
        verified: matchVerdict.rejection === null && faceComparison.rejection === null,
        provider: VLM_FACE_MATCH_PROVIDER,
        matchScore: matchVerdict.matchScore,
        livenessScore: matchVerdict.livenessScore,
        matchConfidence: matchVerdict.matchConfidence,
        livenessConfidence: matchVerdict.livenessConfidence,
        faceMatch: matchVerdict.faceMatch,
        idPhotoFaceDetected: matchVerdict.idPhotoFaceDetected,
        idPhotoKind: matchVerdict.idPhotoKind,
        idPhotoIsRealPhotograph: matchVerdict.idPhotoIsRealPhotograph,
        selfieIsRealPhotograph: matchVerdict.selfieIsRealPhotograph,
        samePerson: matchVerdict.samePerson,
        faceModel: faceComparison.evidence,
        idDocumentId: idDocument.id,
        idDocumentSha256: idDocument.contentSha256,
        ...(refusal === null ? {} : { error: refusal.message }),
      }
    }
    // The judgements behind a strict refusal, for the audit row when no
    // provider result carries them.
    const strictJudgement: StrictRejectionJudgement | null =
      strictRejection && sideRejection && !biometricResult
        ? {
            provider: VLM_FACE_MATCH_PROVIDER,
            rejection: strictRejection.message,
            ...sideRejection.judgement,
          }
        : null
    // A completed check that refused carries its own message; only an attempt
    // with no provider result falls back to the VLM/transport error.
    const extractionError = biometricResult
      ? biometricResult.error ?? null
      : strictRejection?.message
        // A face-model refusal is the assessment below whenever the VLM's own
        // liveness gates passed, so its message is the one that is true.
        ?? (vlmAssessment.ok && faceComparison && !faceComparison.ok ? faceComparison.rejection.message : null)
        ?? vlmResult.error
        ?? "Biometric verification did not run"

    const biometricCompleted = biometricResult?.ok === true
    const extractionStatus = biometricCompleted ? "done" as const : "failed" as const
    const prospectiveAssessment = !vlmAssessment.ok
      ? vlmAssessment
      // A face model that refused before computing a similarity left no
      // provider result; its reason, not "extraction incomplete", is the
      // assessment.
      : faceComparison && !faceComparison.ok
      ? { ok: false as const, reason: faceComparison.rejection.reason }
      : subject && subjectFingerprint
      ? assessBiometricEvidence({
          deletedAt: null,
          verified: false,
          extractionStatus,
          extractionResult,
          extractionError,
          validationMismatch: false,
          validationScore: biometricResult?.matchScore ?? 0,
          biometricMatchScore: biometricResult?.matchScore ?? null,
          biometricLiveness: biometricResult?.livenessScore ?? null,
          biometricVerifiedAt: biometricCompleted ? new Date() : null,
          biometricResult: biometricResult
            ? { ...biometricResult, subjectFingerprint }
            : null,
        }, {
          subject,
          // The copy capture compared against. This decides only whether the
          // match itself passed; the composite gate decides whether it counts.
          idDocument,
          requireDocumentVerified: false,
        })
      : { ok: false as const, reason: "subject_fingerprint_missing" as const }
    const biometricPassed = prospectiveAssessment.ok
    const assessedReason = prospectiveAssessment.ok ? null : prospectiveAssessment.reason
    // The strictest reason is the one recorded: a non-exceptionable refusal
    // from either source wins. Otherwise a completed check names its own
    // refusal (not the generic provider_verification_failed or score gate),
    // the face model's ahead of the VLM's, and an attempt stopped on the
    // selfie side keeps that gate's reason.
    const biometricFailureReason = strictRejection?.reason
      ?? (assessedReason && !isManualKycExceptionableFailureReason(assessedReason)
        ? assessedReason
        : null)
      ?? (biometricResult ? (modelRejection ?? matchVerdict?.rejection)?.reason : null)
      ?? assessedReason

    await persistBiometricOutcome({
      docId,
      clientId,
      tenantId,
      extractionGeneration,
      idDocument,
      extractionStatus,
      extractionError,
      extractionResult,
      biometricResult,
      biometricPassed,
      biometricFailureReason,
      subjectFingerprint,
      strictJudgement,
      faceComparison,
      comparedImageSha256: images ? { idDocument: images.id.sha256, selfie: images.selfie.sha256 } : null,
    })
  } catch (err) {
    console.error("Biometric verification error:", err)
    await persistBiometricOutcome({
      docId,
      clientId,
      tenantId,
      extractionGeneration,
      idDocument,
      extractionStatus: "failed",
      extractionError: err instanceof Error ? err.message : String(err),
      extractionResult: null,
      biometricResult: null,
      biometricPassed: false,
      biometricFailureReason: "extraction_incomplete",
      subjectFingerprint,
      strictJudgement: null,
      faceComparison: null,
      comparedImageSha256: null,
    })
  }
}

async function persistBiometricOutcome(args: {
  docId: string
  clientId: string
  tenantId: string
  extractionGeneration: string
  idDocument: IdDocumentReference
  extractionStatus: "done" | "failed" | "skipped"
  extractionError: string | null
  extractionResult: unknown
  biometricResult: VlmFaceMatchProviderResult | null
  biometricPassed: boolean
  biometricFailureReason: BiometricEvidenceFailureReason | null
  subjectFingerprint: string | null
  strictJudgement: StrictRejectionJudgement | null
  faceComparison: FaceComparison | null
  /** The canonical bytes both judges saw; null when they never ran. */
  comparedImageSha256: { idDocument: string; selfie: string } | null
}): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    await lockAffordabilityClientEvidence(tx, {
      tenantId: args.tenantId,
      clientId: args.clientId,
    })

    const currentDocument = await tx.clientDocument.findFirst({
      where: {
        id: args.docId,
        tenantId: args.tenantId,
        clientId: args.clientId,
        deletedAt: null,
        extractionStatus: "processing",
        extractionGeneration: args.extractionGeneration,
        // A later manual decision supersedes this background callback.
        verified: false,
        verificationNote: null,
      },
      select: {
        id: true,
        verified: true,
        verifiedAt: true,
        verifiedById: true,
        verificationNote: true,
        extractionStatus: true,
        extractionGeneration: true,
      },
    } as never) as unknown as {
      id: string
      verified: boolean
      verifiedAt: Date | null
      verifiedById: string | null
      verificationNote: string | null
      extractionStatus: string
      extractionGeneration: string | null
    } | null
    if (!currentDocument) return false

    const clientBefore = await tx.client.findUnique({
      where: { id: args.clientId, tenantId: args.tenantId },
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
        updatedAt: true,
      },
    })
    if (!clientBefore) return false

    // Bind the attempt by SUBJECT FINGERPRINT, not by row timestamp.
    //
    // This compared `Client.updatedAt` against the value read before the VLM
    // call. `updatedAt` bumps on ANY write to the row, and the VLM call sits
    // in that window for tens of seconds — so an unrelated write failed a
    // biometrically valid attempt and reported it as `subject_identity_changed`,
    // pushing the client to in-person verification. The writers include this
    // pipeline's own: the capture handler's KYC reopen, the composite-KYC write
    // at the bottom of this transaction for a concurrent attempt, and verifying
    // any OTHER document for the same client.
    //
    // The fingerprint covers exactly the identity fields the binding is about
    // (id, idNumber, firstName, lastName, dateOfBirth), so this is precise
    // where the timestamp was a proxy: an unrelated write no longer fails, and
    // a real identity edit still does.
    const subjectUnchanged = args.subjectFingerprint !== null &&
      biometricSubjectFingerprint(clientBefore) === args.subjectFingerprint
    // The provider evidence names the exact ID document the selfie was
    // compared against. That binding is a live gate, not metadata: unless it
    // is still the client's newest ID copy, with the same digest, the
    // attempt fails closed, so a newer upload or a deletion while the
    // callback ran fails it. Whether that copy is VERIFIED is the KYC gates'
    // question (subject_has_composite_kyc): an attempt against an unverified
    // copy is stored, and counts once staff verify that copy. Post-
    // verification replacement is separately covered by the composite-KYC
    // revoke trigger, which lapses the client's KYC when ID_COPY evidence
    // changes.
    const boundIdDocumentId = args.biometricResult?.idDocumentId ?? null
    let idDocumentUnchanged = true
    if (boundIdDocumentId) {
      const currentIdDocuments = await tx.clientDocument.findMany({
        where: {
          tenantId: args.tenantId,
          clientId: args.clientId,
          docType: "ID_COPY" as DocType,
          deletedAt: null,
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: 1,
        select: { id: true, contentSha256: true },
      } as never) as unknown as Array<{ id: string; contentSha256: string | null }>
      const currentIdDocument = currentIdDocuments[0]
      idDocumentUnchanged = currentIdDocument?.id === boundIdDocumentId
        && isSha256Digest(currentIdDocument.contentSha256)
        && currentIdDocument.contentSha256 === args.biometricResult?.idDocumentSha256
    }
    const latestSelfieAtCompletion = await tx.clientDocument.findFirst({
      where: {
        tenantId: args.tenantId,
        clientId: args.clientId,
        docType: "SELFIE",
      },
      orderBy: latestSelfieOrder(),
      select: { id: true },
    })
    const outcomeIsCurrent = latestSelfieAtCompletion?.id === args.docId
    const biometricFailureReason: BiometricEvidenceFailureReason | null =
      // No fingerprint means the attempt died before the subject was ever read
      // (the catch path below). There is no evidence to bind to a subject, so
      // report why it actually failed instead of claiming the identity changed.
      // Every such path already carries a reason and cannot have passed.
      args.subjectFingerprint === null
      ? args.biometricFailureReason ?? "subject_fingerprint_missing"
      : !subjectUnchanged || !idDocumentUnchanged
      ? "subject_identity_changed"
      : args.biometricPassed && !outcomeIsCurrent
          ? "superseded_biometric_evidence"
          : args.biometricFailureReason
    const biometricPassed = args.biometricPassed && biometricFailureReason === null
    const extractionStatus = biometricPassed ? args.extractionStatus : "failed"
    const extractionError = biometricFailureReason === "subject_identity_changed"
      ? "Client evidence changed during biometric verification"
      : biometricFailureReason === "superseded_biometric_evidence"
          ? "Biometric attempt was superseded by a newer selfie"
          : args.extractionError
    const completedAt = new Date()
    const extractionResultJson = args.extractionResult === null || args.extractionResult === undefined
      ? Prisma.JsonNull
      : JSON.parse(JSON.stringify(args.extractionResult)) as Prisma.InputJsonValue
    const biometricResultJson = {
      ...(args.biometricResult === null
        ? {}
        : JSON.parse(JSON.stringify(args.biometricResult)) as Record<string, unknown>),
      // Also on an attempt with no provider result: an ID-portrait refusal
      // closes the in-person route only over the ID copy it was judged on.
      idDocumentId: args.idDocument.id,
      idDocumentSha256: args.idDocument.contentSha256,
      comparedImageSha256: args.comparedImageSha256,
      subjectFingerprint: args.subjectFingerprint,
      biometricFailureReason,
    } as Prisma.InputJsonValue
    const documentChanged = await tx.clientDocument.updateMany({
      where: {
        id: args.docId,
        tenantId: args.tenantId,
        clientId: args.clientId,
        deletedAt: null,
        extractionStatus: "processing",
        extractionGeneration: args.extractionGeneration,
        verified: false,
        verificationNote: null,
      },
      data: {
        extractionStatus,
        extractionStartedAt: null,
        extractionError,
        extractionResult: extractionResultJson,
        validationMismatch: !biometricPassed,
        validationScore: args.biometricResult?.matchScore ?? 0,
        biometricMatchScore: args.biometricResult?.matchScore ?? null,
        biometricLiveness: args.biometricResult?.livenessScore ?? null,
        biometricVerifiedAt: biometricPassed ? completedAt : null,
        biometricResult: biometricResultJson,
        verified: biometricPassed,
        verifiedAt: biometricPassed ? completedAt : null,
        verifiedById: null,
        verificationNote: biometricPassed
          ? "Automatically verified by face comparison against the ID document photograph"
          : extractionError ?? "Biometric verification failed",
      },
    } as never)
    if (documentChanged.count !== 1) return false

    const compositeKyc = await readCompositeKycState(
      tx as unknown as CompositeKycReader,
      {
        tenantId: args.tenantId,
        clientId: args.clientId,
        subject: clientBefore,
        existing: clientBefore,
        completion: {
          verifiedAt: completedAt,
          verifiedById: null,
          method: "BIOMETRIC",
        },
      },
    )
    if ((compositeKyc.latestSelfieId === args.docId) !== outcomeIsCurrent) {
      throw new Error("Biometric attempt chronology changed while the client evidence lock was held")
    }

    let clientAfter: ClientKycState = clientBefore
    if (outcomeIsCurrent) {
      clientAfter = await tx.client.update({
        where: { id: args.clientId, tenantId: args.tenantId },
        data: compositeKyc.state,
        select: {
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
          updatedAt: true,
        },
      })
    }

    await tx.auditLog.create({
      data: {
        tenantId: args.tenantId,
        userId: null,
        userEmail: "system@biometric",
        action: biometricPassed
          ? clientAfter.kycStatus === "VERIFIED"
            ? AuditAction.KYC_APPROVED
            : AuditAction.DOCUMENT_VERIFIED
          : AuditAction.KYC_REJECTED,
        entity: "ClientDocument",
        entityId: args.docId,
        oldValue: {
          document: {
            verified: currentDocument.verified,
            extractionStatus: currentDocument.extractionStatus,
            extractionGeneration: currentDocument.extractionGeneration,
          },
          clientKyc: clientKycAuditValue(clientBefore),
        },
        newValue: {
          document: {
            verified: biometricPassed,
            extractionStatus,
            extractionError,
            extractionGeneration: args.extractionGeneration,
            validationMismatch: !biometricPassed,
            matchScore: args.biometricResult?.matchScore ?? null,
            livenessScore: args.biometricResult?.livenessScore ?? null,
            subjectFingerprint: args.subjectFingerprint,
            biometricFailureReason,
            latestSelfie: outcomeIsCurrent,
            // The model's judgements behind the outcome. No personal data:
            // enums, booleans and confidences only.
            faceMatchVerdict: args.biometricResult
              ? {
                  provider: args.biometricResult.provider,
                  rejection: args.biometricResult.error ?? null,
                  idPhotoKind: args.biometricResult.idPhotoKind,
                  idPhotoIsRealPhotograph: args.biometricResult.idPhotoIsRealPhotograph,
                  idPhotoFaceDetected: args.biometricResult.idPhotoFaceDetected,
                  selfieIsRealPhotograph: args.biometricResult.selfieIsRealPhotograph,
                  samePerson: args.biometricResult.samePerson,
                  faceMatch: args.biometricResult.faceMatch,
                  matchConfidence: args.biometricResult.matchConfidence,
                  livenessConfidence: args.biometricResult.livenessConfidence,
                }
              : args.strictJudgement,
            // The face model's outcome: counts, similarity, threshold and
            // model checksums, or the refusal that stopped it.
            faceComparison: args.faceComparison,
          },
          clientKyc: clientKycAuditValue(clientAfter),
        },
      },
    })

    return true
  })
}
