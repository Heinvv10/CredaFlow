/**
 * Database proof for migration 20261011080000_face_match_v3_evidence.
 *
 * Supersedes face-match-v2-evidence.integration.test.ts: every case it held
 * is here on v3 evidence (v2 evidence no longer verifies, so its positive
 * cases stopped being true), plus the face model's own fields.
 *
 * Run against a throwaway fully migrated PostgreSQL database:
 *
 *   RUN_FACE_MATCH_V3_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/kyc/face-match-v3-evidence.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { afterAll, describe, expect, it } from "vitest"
import { PrismaClient } from "@prisma/client"
import { biometricSubjectFingerprint } from "@/lib/kyc/biometric-evidence"
import { PASSING_FACE_MODEL_EVIDENCE } from "@/lib/kyc/face-model/evidence.test-helpers"
import {
  MANUAL_KYC_EXCEPTION_KIND,
  MANUAL_KYC_EXCEPTION_VERSION,
} from "@/lib/kyc/manual-exception"

const RUN = process.env.RUN_FACE_MATCH_V3_IT === "1"
const suite = RUN ? describe.sequential : describe.skip
const db = new PrismaClient()
const token = randomUUID().replaceAll("-", "")
const NOT_VERIFIED = "Client KYC cannot be VERIFIED without current composite evidence"
const approvedAt = new Date("2026-10-10T12:00:00.000Z")
const ID_SHA = "a".repeat(64)

const v3Pass = {
  ok: true,
  verified: true,
  provider: "vlm-face-match-v3",
  faceModel: PASSING_FACE_MODEL_EVIDENCE,
  matchScore: 95,
  livenessScore: 97,
  idPhotoKind: "photograph",
  idPhotoIsRealPhotograph: true,
  idPhotoFaceDetected: true,
  selfieIsRealPhotograph: true,
  samePerson: "same",
  faceMatch: true,
  matchConfidence: 0.95,
  livenessConfidence: 0.97,
}

let sequence = 0

/** A client with four verified core documents and one SELFIE row. */
async function clientWithSelfie(selfie: Record<string, unknown>) {
  sequence += 1
  const tenantId = `tenant_fm_v3_${sequence}_${token}`
  const clientId = `client_fm_v3_${sequence}_${token}`
  const selfieId = `selfie_fm_v3_${sequence}_${token}`
  const subject = {
    id: clientId,
    idNumber: `FMV3-${sequence}-${token}`,
    firstName: "Synthetic",
    lastName: "FaceMatch",
    dateOfBirth: new Date("1990-04-05T00:00:00.000Z"),
  }
  const subjectFingerprint = biometricSubjectFingerprint(subject)
  await db.tenant.create({
    data: { id: tenantId, slug: `fm-v3-${sequence}-${token}`, name: "Face match v3 integration" },
  })
  await db.user.create({ data: {
    id: `reviewer_${clientId}`, tenantId, email: `reviewer-${clientId}@test.invalid`, password: "synthetic",
    role: "ADMIN", active: true, totpEnabled: true, lastTotpCounter: 1,
  } })
  await db.client.create({
    data: {
      ...subject,
      tenantId,
      reference: `CLI-FMV3-${sequence}-${token}`,
      email: `fm-v3-${sequence}-${token}@test.invalid`,
      phone: "+27820000088",
    },
  })
  await db.clientDocument.createMany({
    data: (["ID_COPY", "PROOF_OF_ADDRESS", "PAYSLIP", "BANK_STATEMENT"] as const).map(
      (docType, index) => ({
        id: `fm_v3_core_${sequence}_${index}_${token}`,
        tenantId,
        clientId,
        docType,
        fileUrl: "",
        fileName: `${docType.toLowerCase()}.pdf`,
        verified: true,
        verifiedAt: approvedAt,
        contentSha256: ID_SHA,
      }),
    ),
  })
  const sha = "d".repeat(64)
  const row = await db.clientDocument.create({
    data: {
      id: selfieId,
      tenantId,
      clientId,
      docType: "SELFIE",
      fileUrl: "",
      fileName: "selfie.jpg",
      contentSha256: sha,
      ...selfie,
      biometricResult: {
        // Compared against the client's one verified ID copy.
        idDocumentId: `fm_v3_core_${sequence}_0_${token}`,
        idDocumentSha256: ID_SHA,
        ...(selfie.biometricResult as Record<string, unknown>),
        subjectFingerprint,
      },
    },
    select: { biometricResult: true },
  })
  return { tenantId, clientId, selfieId, sha, subjectFingerprint, row }
}

function failedSelfie(biometricFailureReason: string) {
  const message = "Synthetic refusal recorded by the face match"
  return {
    extractionStatus: "failed",
    extractionError: message,
    verificationNote: message,
    validationMismatch: true,
    validationScore: 85,
    biometricMatchScore: 85,
    biometricLiveness: 95,
    biometricResult: { ...v3Pass, verified: false, error: message, biometricFailureReason },
  }
}

function passedSelfie(biometricResult: Record<string, unknown>) {
  return {
    verified: true,
    verifiedAt: approvedAt,
    extractionStatus: "done",
    extractionResult: {
      faceDetected: { value: true },
      facesCount: { value: 1 },
      isLive: { value: true },
      quality: { value: "good" },
    },
    validationMismatch: false,
    validationScore: 95,
    biometricMatchScore: 95,
    biometricLiveness: 97,
    biometricVerifiedAt: approvedAt,
    biometricResult,
  }
}

async function recordException(
  fixture: Awaited<ReturnType<typeof clientWithSelfie>>,
  biometricFailureReason: string,
) {
  await db.complianceRecord.create({
    data: {
      tenantId: fixture.tenantId,
      type: "KYC_EXCEPTION",
      referenceId: fixture.clientId,
      idempotencyKey: `kyc-exception:${fixture.clientId}:${fixture.selfieId}:${fixture.sha}`,
      status: "COMPLETED",
      completedAt: approvedAt,
      data: {
        kind: MANUAL_KYC_EXCEPTION_KIND,
        version: MANUAL_KYC_EXCEPTION_VERSION,
        clientId: fixture.clientId,
        documentId: fixture.selfieId,
        documentSha256: fixture.sha,
        subjectFingerprint: fixture.subjectFingerprint,
        biometricFailureReason,
        reason: "Synthetic integration exception after a controlled failed biometric attempt.",
        supportingEvidence: "Four verified synthetic core documents and the exact failed selfie were reviewed.",
        approvedAt: approvedAt.toISOString(),
        approvedById: `reviewer_${fixture.clientId}`,
        approvedByEmail: `reviewer-${fixture.clientId}@test.invalid`,
        approvedWithTotp: true,
      },
    },
  })
}

function verify(clientId: string, method: "PHYSICAL" | "BIOMETRIC") {
  return db.client.update({
    where: { id: clientId },
    data: {
      kycStatus: "VERIFIED",
      kycVerifiedAt: approvedAt,
      kycVerifiedById: method === "PHYSICAL" ? `reviewer_${clientId}` : null,
      kycVerificationMethod: method,
    },
    select: { kycStatus: true },
  })
}

suite("face match v3 evidence in the database", () => {
  afterAll(async () => {
    await db.$disconnect()
  })

  it.each(["id_document_portrait_invalid", "selfie_not_real_photograph"])(
    "stores a selfie refused as %s",
    async (reason) => {
      const fixture = await clientWithSelfie(failedSelfie(reason))
      expect(fixture.row.biometricResult).toEqual(
        expect.objectContaining({ biometricFailureReason: reason }),
      )
    },
  )

  it.each(["id_document_portrait_invalid", "selfie_not_real_photograph"])(
    "refuses a manual exception over a selfie refused as %s",
    async (reason) => {
      const fixture = await clientWithSelfie(failedSelfie(reason))
      await recordException(fixture, reason)
      await expect(verify(fixture.clientId, "PHYSICAL")).rejects.toThrow(NOT_VERIFIED)
    },
  )

  it("refuses an exception that relabels the refusal as an exceptionable reason", async () => {
    const fixture = await clientWithSelfie(failedSelfie("id_document_portrait_invalid"))
    await recordException(fixture, "provider_verification_failed")
    await expect(verify(fixture.clientId, "PHYSICAL")).rejects.toThrow(NOT_VERIFIED)
  })

  it("still accepts a manual exception over provider_verification_failed", async () => {
    const fixture = await clientWithSelfie(failedSelfie("provider_verification_failed"))
    await recordException(fixture, "provider_verification_failed")
    await expect(verify(fixture.clientId, "PHYSICAL")).resolves.toEqual({ kycStatus: "VERIFIED" })
  })

  it("verifies a client on consistent v3 biometric evidence", async () => {
    const fixture = await clientWithSelfie(passedSelfie(v3Pass))
    await expect(verify(fixture.clientId, "BIOMETRIC")).resolves.toEqual({ kycStatus: "VERIFIED" })
  })

  it.each([
    ["v1 evidence", { provider: "vlm-face-match-v1" }],
    ["v2 evidence", { provider: "vlm-face-match-v2" }],
    ["v2-shaped evidence tagged v3 with no face model", { faceModel: undefined }],
    ["untagged evidence", { provider: undefined }],
    ["a silhouette ID portrait", { idPhotoKind: "silhouette_placeholder" }],
    ["an ID photo that is not real", { idPhotoIsRealPhotograph: false }],
    ["a string 'true' instead of a boolean", { idPhotoIsRealPhotograph: "true" }],
    ["no face on the ID", { idPhotoFaceDetected: false }],
    ["a selfie that is not real", { selfieIsRealPhotograph: false }],
    ["an uncertain same-person verdict", { samePerson: "uncertain" }],
    ["faceMatch false", { faceMatch: false }],
    ["a raw match confidence below 0.7", { matchConfidence: 0.695 }],
    ["a raw liveness confidence below 0.7", { livenessConfidence: 0.695 }],
    ["no raw match confidence", { matchConfidence: undefined }],
    ["a string raw liveness confidence", { livenessConfidence: "0.97" }],
    ["a raw match confidence of 1.0001", { matchConfidence: 1.0001 }],
    ["a raw liveness confidence of 1.0001", { livenessConfidence: 1.0001 }],
    ["a raw match confidence of 95", { matchConfidence: 95 }],
    ["a raw liveness confidence of 95", { livenessConfidence: 95 }],
  ])("does not verify a client on verified:true %s", async (_label, change) => {
    const fixture = await clientWithSelfie(passedSelfie({ ...v3Pass, ...change }))
    await expect(verify(fixture.clientId, "BIOMETRIC")).rejects.toThrow(NOT_VERIFIED)
  })

  it("does not verify legacy provider evidence behind the VLM-unavailable marker", async () => {
    const fixture = await clientWithSelfie({
      // Scores and raw confidences all pass; only the v3 verdict is absent.
      ...passedSelfie({
        ok: true, verified: true, matchScore: 95, livenessScore: 97,
        matchConfidence: 0.95, livenessConfidence: 0.97,
      }),
      extractionResult: { vlmUnavailable: true },
    })
    await expect(verify(fixture.clientId, "BIOMETRIC")).rejects.toThrow(NOT_VERIFIED)
  })

  // The VLM's confident "same" cannot verify a client the face model did not
  // confirm, however the stored face-model fields were edited.
  it.each([
    ["a similarity below the threshold", { similarity: 0.2 }],
    ["a similarity just below the threshold", { similarity: 0.36299999999999993 }],
    ["a similarity above 1", { similarity: 1.0001 }],
    ["a string similarity", { similarity: "0.71" }],
    ["samePerson false", { samePerson: false }],
    ["samePerson as the string true", { samePerson: "true" }],
    ["a lowered threshold", { threshold: 0.2, similarity: 0.3 }],
    ["a tampered detector checksum", { detectorSha256: "f".repeat(64) }],
    ["a tampered recognizer checksum", { recognizerSha256: "f".repeat(64) }],
    ["an int8 detector", { detector: "face_detection_yunet_2023mar_int8" }],
    ["two selfie faces", { selfieFaceCount: 2 }],
    ["no ID face", { idFaceCount: 0 }],
    ["a fractional ID face count", { idFaceCount: 1.5 }],
    ["a string ID face count", { idFaceCount: "1" }],
    ["one ID face carrying a second-face ratio", { idSecondFaceAreaRatio: 0.2 }],
    ["two ID faces without a ratio", { idFaceCount: 2 }],
    ["two comparable ID faces", { idFaceCount: 2, idSecondFaceAreaRatio: 0.51 }],
    ["a string second-face ratio", { idFaceCount: 2, idSecondFaceAreaRatio: "0.1" }],
    ["65 ID faces", { idFaceCount: 65, idSecondFaceAreaRatio: 0.01 }],
    ["a second-face ratio of 0", { idFaceCount: 2, idSecondFaceAreaRatio: 0 }],
    ["ID eyes closer than 24 px", { idInterOcularPx: 23 }],
    ["a selfie geometry margin below 0.15", { selfieGeometryMargin: 0.1 }],
    ["an ID crop sharpness below 100", { idSharpness: 64 }],
    ["no selfie sharpness", { selfieSharpness: undefined }],
    ["an unknown detector pass", { idDetectPass: "tiles" }],
  ])("does not verify a client on v3 evidence with %s", async (_label, change) => {
    const fixture = await clientWithSelfie(passedSelfie({
      ...v3Pass,
      faceModel: { ...PASSING_FACE_MODEL_EVIDENCE, ...change },
    }))
    await expect(verify(fixture.clientId, "BIOMETRIC")).rejects.toThrow(NOT_VERIFIED)
  })

  it.each([
    ["a similarity exactly at the threshold", { similarity: 0.363 }],
    ["a similarity of exactly 1", { similarity: 1 }],
    ["a small ghost face on the ID", { idFaceCount: 2, idSecondFaceAreaRatio: 0.1 }],
    ["a second ID face at exactly half the area", { idFaceCount: 3, idSecondFaceAreaRatio: 0.5 }],
    ["the ID face found on the full-resolution pass", { idDetectPass: "full" }],
  ])("verifies a client on v3 evidence with %s", async (_label, change) => {
    const fixture = await clientWithSelfie(passedSelfie({
      ...v3Pass,
      faceModel: { ...PASSING_FACE_MODEL_EVIDENCE, ...change },
    }))
    await expect(verify(fixture.clientId, "BIOMETRIC")).resolves.toEqual({ kycStatus: "VERIFIED" })
  })

  it("verifies raw confidences of exactly 1", async () => {
    const fixture = await clientWithSelfie(
      passedSelfie({ ...v3Pass, matchConfidence: 1, livenessConfidence: 1 }),
    )
    await expect(verify(fixture.clientId, "BIOMETRIC")).resolves.toEqual({ kycStatus: "VERIFIED" })
  })

  it("verifies raw confidences exactly at 0.7", async () => {
    const fixture = await clientWithSelfie(
      passedSelfie({ ...v3Pass, matchConfidence: 0.7, livenessConfidence: 0.7 }),
    )
    await expect(verify(fixture.clientId, "BIOMETRIC")).resolves.toEqual({ kycStatus: "VERIFIED" })
  })
})
