/**
 * Seeding shared by the RUN_KYC_REDERIVE_IT suites: synthetic clients whose
 * stored KYC status is PENDING while the evidence on file derives VERIFIED.
 */
import type { PrismaClient } from "@prisma/client"
import { biometricSubjectFingerprint } from "@/lib/kyc/biometric-evidence"
import {
  IN_PERSON_KYC_VERIFICATION_KIND,
  IN_PERSON_KYC_VERIFICATION_VERSION,
} from "@/lib/kyc/in-person-verification"

export const [A, B, C] = ["a", "b", "c"].map((hex) => hex.repeat(64))
export const DOB = new Date("1990-04-05T00:00:00.000Z")
export const day = (n: number) => new Date(Date.UTC(2026, 6, 1 + n))
export const ATTESTED_AT = new Date("2026-07-10T09:00:00.000Z")

/** The face model's passing evidence (lib/kyc/face-model/evidence.ts), as written. */
const FACE_MODEL_PASS = {
  detector: "face_detection_yunet_2023mar",
  detectorSha256: "8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4",
  detectorRuntimeSha256: "c95b66a69803a457acc19433ed72572bdb62fff368306841f9ed108a65e9f1f1",
  recognizer: "face_recognition_sface_2021dec",
  recognizerSha256: "0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79",
  selfieFaceCount: 1, idFaceCount: 1, idSecondFaceAreaRatio: null, idDetectPass: "fit640",
  idInterOcularPx: 100, selfieInterOcularPx: 240, idGeometryMargin: 0.4, selfieGeometryMargin: 0.5,
  idSharpness: 1100, selfieSharpness: 1200, similarity: 0.71, threshold: 0.363, samePerson: true,
}

export type IdCopy = { sha: string; verified: boolean; on: number }

/** One tenant's seeding. `label` keeps two suites' client ids apart. */
export function rederiveFixture(db: PrismaClient, scope: { tenantId: string; token: string; attesterId: string; label: string }) {
  const { tenantId, token, attesterId, label } = scope
  let sequence = 0

  /** A synthetic client on four verified core documents, stored PENDING; `id_<client>` is the day-0 ID copy. */
  async function seedClient(extraIdCopies: IdCopy[] = []) {
    sequence += 1
    const clientId = `c_${label}_${sequence}_${token}`
    const subject = { id: clientId, idNumber: `${label.toUpperCase()}-${sequence}-${token}`, firstName: "Synthetic", lastName: "Rederive", dateOfBirth: DOB }
    await db.client.create({ data: {
      ...subject, tenantId, reference: `CLI-${label.toUpperCase()}-${sequence}-${token}`,
      email: `${label}-${sequence}-${token}@test.invalid`, phone: "+27820000067",
    } })
    const idCopyId = `id_${clientId}`
    await db.clientDocument.createMany({ data: [
      { id: idCopyId, tenantId, clientId, docType: "ID_COPY", fileUrl: "", fileName: "id.pdf", verified: true, verifiedAt: day(0), contentSha256: A, createdAt: day(0) },
      ...extraIdCopies.map((copy, index) => ({
        id: `id_extra${index}_${clientId}`, tenantId, clientId, docType: "ID_COPY" as const, fileUrl: "", fileName: "id.pdf",
        verified: copy.verified, verifiedAt: copy.verified ? day(copy.on) : null, contentSha256: copy.sha, createdAt: day(copy.on),
      })),
      ...(["PROOF_OF_ADDRESS", "PAYSLIP", "BANK_STATEMENT"] as const).map((docType) => ({
        id: `${docType}_${clientId}`, tenantId, clientId, docType, fileUrl: "", fileName: "core.pdf",
        verified: true, verifiedAt: day(0), contentSha256: C, createdAt: day(0),
      })),
    ] })
    return { clientId, idCopyId, subject }
  }

  /**
   * seedClient plus an in-person attestation over the ID copy `id_<client>`
   * (day 0), or over extra copy `attestExtra`.
   */
  async function seedRestorableClient(extraIdCopies: IdCopy[] = [], attestExtra?: number) {
    const { clientId, idCopyId, subject } = await seedClient(extraIdCopies)
    const attestedId = attestExtra === undefined ? idCopyId : `id_extra${attestExtra}_${clientId}`
    await db.complianceRecord.create({ data: {
      tenantId, type: "KYC_EXCEPTION", referenceId: clientId, status: "COMPLETED", completedAt: ATTESTED_AT,
      data: {
        kind: IN_PERSON_KYC_VERIFICATION_KIND, version: IN_PERSON_KYC_VERIFICATION_VERSION, clientId,
        idDocumentId: attestedId, idDocumentSha256: attestExtra === undefined ? A : extraIdCopies[attestExtra].sha, subjectFingerprint: biometricSubjectFingerprint(subject),
        method: "IN_PERSON_BRANCH", note: "Synthetic client attended a branch; face matched the ID photo.",
        approvedAt: ATTESTED_AT.toISOString(), approvedById: attesterId,
        approvedByEmail: `attester-${token}@test.invalid`, approvedWithTotp: true,
      },
    } })
    return { clientId, idCopyId }
  }

  /**
   * A selfie that passed the v3 face match against `idCopyId` (digest A), as
   * the biometric worker writes it, verified by the provider at `verifiedAt`.
   */
  async function seedPassedSelfie(clientId: string, idCopyId: string, subject: Parameters<typeof biometricSubjectFingerprint>[0], verifiedAt: Date) {
    const selfieId = `selfie_${clientId}`
    await db.clientDocument.create({ data: {
      id: selfieId, tenantId, clientId, docType: "SELFIE", fileUrl: "", fileName: "selfie.jpg",
      verified: true, verifiedAt, contentSha256: "d".repeat(64), createdAt: verifiedAt,
      extractionStatus: "done", validationMismatch: false, validationScore: 95,
      extractionResult: { faceDetected: { value: true }, facesCount: { value: 1 }, isLive: { value: true }, quality: { value: "good" } },
      biometricMatchScore: 95, biometricLiveness: 97, biometricVerifiedAt: verifiedAt,
      biometricResult: {
        ok: true, verified: true, provider: "vlm-face-match-v3", faceModel: FACE_MODEL_PASS, matchScore: 95, livenessScore: 97,
        idPhotoKind: "photograph", idPhotoIsRealPhotograph: true, idPhotoFaceDetected: true, selfieIsRealPhotograph: true,
        samePerson: "same", faceMatch: true, matchConfidence: 0.95, livenessConfidence: 0.97,
        idDocumentId: idCopyId, idDocumentSha256: A, subjectFingerprint: biometricSubjectFingerprint(subject),
      },
    } })
    return selfieId
  }

  return { seedClient, seedRestorableClient, seedPassedSelfie }
}
