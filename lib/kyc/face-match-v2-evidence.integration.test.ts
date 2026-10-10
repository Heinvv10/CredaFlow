/**
 * Database proof for migration 20261010150000_face_match_v2_evidence.
 *
 * Run against a throwaway fully migrated PostgreSQL database:
 *
 *   RUN_FACE_MATCH_V2_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/kyc/face-match-v2-evidence.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { afterAll, describe, expect, it } from "vitest"
import { PrismaClient } from "@prisma/client"
import { biometricSubjectFingerprint } from "@/lib/kyc/biometric-evidence"
import {
  MANUAL_KYC_EXCEPTION_KIND,
  MANUAL_KYC_EXCEPTION_VERSION,
} from "@/lib/kyc/manual-exception"

const RUN = process.env.RUN_FACE_MATCH_V2_IT === "1"
const suite = RUN ? describe.sequential : describe.skip
const db = new PrismaClient()
const token = randomUUID().replaceAll("-", "")
const NOT_VERIFIED = "Client KYC cannot be VERIFIED without current composite evidence"
const approvedAt = new Date("2026-10-10T12:00:00.000Z")

const v2Pass = {
  ok: true,
  verified: true,
  provider: "vlm-face-match-v2",
  matchScore: 95,
  livenessScore: 97,
  idPhotoKind: "photograph",
  idPhotoIsRealPhotograph: true,
  idPhotoFaceDetected: true,
  selfieIsRealPhotograph: true,
  samePerson: "same",
  faceMatch: true,
}

let sequence = 0

/** A client with four verified core documents and one SELFIE row. */
async function clientWithSelfie(selfie: Record<string, unknown>) {
  sequence += 1
  const tenantId = `tenant_fm_v2_${sequence}_${token}`
  const clientId = `client_fm_v2_${sequence}_${token}`
  const selfieId = `selfie_fm_v2_${sequence}_${token}`
  const subject = {
    id: clientId,
    idNumber: `FMV2-${sequence}-${token}`,
    firstName: "Synthetic",
    lastName: "FaceMatch",
    dateOfBirth: new Date("1990-04-05T00:00:00.000Z"),
  }
  const subjectFingerprint = biometricSubjectFingerprint(subject)
  await db.tenant.create({
    data: { id: tenantId, slug: `fm-v2-${sequence}-${token}`, name: "Face match v2 integration" },
  })
  await db.client.create({
    data: {
      ...subject,
      tenantId,
      reference: `CLI-FMV2-${sequence}-${token}`,
      email: `fm-v2-${sequence}-${token}@test.invalid`,
      phone: "+27820000088",
    },
  })
  await db.clientDocument.createMany({
    data: (["ID_COPY", "PROOF_OF_ADDRESS", "PAYSLIP", "BANK_STATEMENT"] as const).map(
      (docType, index) => ({
        id: `fm_v2_core_${sequence}_${index}_${token}`,
        tenantId,
        clientId,
        docType,
        fileUrl: "",
        fileName: `${docType.toLowerCase()}.pdf`,
        verified: true,
        verifiedAt: approvedAt,
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
    biometricResult: { ...v2Pass, verified: false, error: message, biometricFailureReason },
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
        approvedById: `reviewer_fm_v2_${token}`,
        approvedByEmail: "reviewer@test.invalid",
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
      kycVerifiedById: method === "PHYSICAL" ? `reviewer_fm_v2_${token}` : null,
      kycVerificationMethod: method,
    },
    select: { kycStatus: true },
  })
}

suite("face match v2 evidence in the database", () => {
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

  it("verifies a client on consistent v2 biometric evidence", async () => {
    const fixture = await clientWithSelfie(passedSelfie(v2Pass))
    await expect(verify(fixture.clientId, "BIOMETRIC")).resolves.toEqual({ kycStatus: "VERIFIED" })
  })

  it.each([
    ["v1 evidence", { provider: "vlm-face-match-v1" }],
    ["untagged evidence", { provider: undefined }],
    ["a silhouette ID portrait", { idPhotoKind: "silhouette_placeholder" }],
    ["an ID photo that is not real", { idPhotoIsRealPhotograph: false }],
    ["a string 'true' instead of a boolean", { idPhotoIsRealPhotograph: "true" }],
    ["no face on the ID", { idPhotoFaceDetected: false }],
    ["a selfie that is not real", { selfieIsRealPhotograph: false }],
    ["an uncertain same-person verdict", { samePerson: "uncertain" }],
    ["faceMatch false", { faceMatch: false }],
  ])("does not verify a client on verified:true %s", async (_label, change) => {
    const fixture = await clientWithSelfie(passedSelfie({ ...v2Pass, ...change }))
    await expect(verify(fixture.clientId, "BIOMETRIC")).rejects.toThrow(NOT_VERIFIED)
  })
})
