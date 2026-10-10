import { describe, expect, it } from "vitest"
import {
  MANUAL_KYC_EXCEPTION_KIND,
  MANUAL_KYC_EXCEPTION_VERSION,
  currentManualKycException,
  parseManualKycExceptionEvidence,
} from "./manual-exception"
import {
  biometricSubjectFingerprint,
  type BiometricEvidenceFailureReason,
} from "./biometric-evidence"

const subject = {
  id: "client-1",
  idNumber: "9912310000085",
  firstName: "Synthetic",
  lastName: "Customer",
  dateOfBirth: new Date("1999-12-31T00:00:00.000Z"),
}
const approvedAt = new Date("2026-07-23T19:30:00.000Z")
const sha256 = "a".repeat(64)
const evidence = {
  kind: MANUAL_KYC_EXCEPTION_KIND,
  version: MANUAL_KYC_EXCEPTION_VERSION,
  clientId: subject.id,
  documentId: "selfie-1",
  documentSha256: sha256,
  subjectFingerprint: biometricSubjectFingerprint(subject),
  biometricFailureReason: "face_not_detected" as const,
  reason: "Senior reviewed the failed automated result in staging.",
  supportingEvidence: "Physical identity comparison completed against the ID copy.",
  approvedAt: approvedAt.toISOString(),
  approvedById: "admin-1",
  approvedByEmail: "admin@example.test",
}

describe("manual KYC exception evidence", () => {
  it("accepts a reasoned record bound to the exact failed selfie and subject", () => {
    expect(currentManualKycException(
      { id: "exception-1", completedAt: approvedAt, data: evidence },
      {
        clientId: subject.id,
        subject,
        latestSelfie: {
          id: "selfie-1",
          deletedAt: null,
          contentSha256: sha256,
          extractionStatus: "failed",
        },
        biometricAssessment: { ok: false, reason: "face_not_detected" },
      },
    )).toEqual(evidence)
  })

  it.each([
    ["new selfie", { id: "selfie-2" }],
    ["changed bytes", { contentSha256: "b".repeat(64) }],
    ["deleted selfie", { deletedAt: new Date("2026-07-23T20:00:00.000Z") }],
  ] as const)("invalidates on %s", (_label, latestChanges) => {
    expect(currentManualKycException(
      { id: "exception-1", completedAt: approvedAt, data: evidence },
      {
        clientId: subject.id,
        subject,
        latestSelfie: {
          id: "selfie-1",
          deletedAt: null,
          contentSha256: sha256,
          extractionStatus: "failed",
          ...latestChanges,
        },
        biometricAssessment: { ok: false, reason: "face_not_detected" },
      },
    )).toBeNull()
  })

  it("invalidates when identity or the terminal failure reason changes", () => {
    const record = { id: "exception-1", completedAt: approvedAt, data: evidence }
    const latestSelfie = {
      id: "selfie-1",
      deletedAt: null,
      contentSha256: sha256,
      extractionStatus: "failed",
    }
    expect(currentManualKycException(record, {
      clientId: subject.id,
      subject: { ...subject, lastName: "Changed" },
      latestSelfie,
      biometricAssessment: { ok: false, reason: "face_not_detected" },
    })).toBeNull()
    expect(currentManualKycException(record, {
      clientId: subject.id,
      subject,
      latestSelfie,
      biometricAssessment: { ok: false, reason: "vlm_liveness_failed" },
    })).toBeNull()
  })

  it("never replaces a genuine biometric pass", () => {
    expect(currentManualKycException(
      { id: "exception-1", completedAt: approvedAt, data: evidence },
      {
        clientId: subject.id,
        subject,
        latestSelfie: {
          id: "selfie-1",
          deletedAt: null,
          contentSha256: sha256,
          extractionStatus: "failed",
        },
        biometricAssessment: { ok: true },
      },
    )).toBeNull()
  })

  it("rejects malformed or incomplete audit evidence", () => {
    expect(parseManualKycExceptionEvidence({ ...evidence, reason: "" })).toBeNull()
    expect(parseManualKycExceptionEvidence({
      ...evidence,
      reason: "too short",
    })).toBeNull()
    expect(parseManualKycExceptionEvidence({
      ...evidence,
      supportingEvidence: "also too short",
    })).toBeNull()
    expect(parseManualKycExceptionEvidence({
      ...evidence,
      documentSha256: "not-a-hash",
    })).toBeNull()
  })

  it.each([
    "extraction_incomplete",
    "biometric_evidence_missing",
    "document_deleted",
    "document_not_verified",
    "superseded_biometric_evidence",
    "subject_fingerprint_missing",
    "subject_identity_changed",
    "provider_verification_missing",
    "simulated_provider_evidence",
    // No real face on one side: a senior has nothing to reason over.
    "id_document_portrait_invalid",
    "selfie_not_real_photograph",
  ] satisfies BiometricEvidenceFailureReason[])(
    "rejects non-exceptionable failure reason %s",
    (biometricFailureReason) => {
      const invalidEvidence = { ...evidence, biometricFailureReason }
      expect(parseManualKycExceptionEvidence(invalidEvidence)).toBeNull()
      expect(currentManualKycException(
        {
          id: "exception-1",
          completedAt: approvedAt,
          data: invalidEvidence,
        },
        {
          clientId: subject.id,
          subject,
          latestSelfie: {
            id: "selfie-1",
            deletedAt: null,
            contentSha256: sha256,
            extractionStatus: "failed",
          },
          biometricAssessment: { ok: false, reason: biometricFailureReason },
        },
      )).toBeNull()
    },
  )

  it.each(["done", "pending", "processing"])(
    "rejects an otherwise matching exception for selfie status %s",
    (extractionStatus) => {
      expect(currentManualKycException(
        { id: "exception-1", completedAt: approvedAt, data: evidence },
        {
          clientId: subject.id,
          subject,
          latestSelfie: {
            id: "selfie-1",
            deletedAt: null,
            contentSha256: sha256,
            extractionStatus,
          },
          biometricAssessment: { ok: false, reason: "face_not_detected" },
        },
      )).toBeNull()
    },
  )

  it.each(["failed", "skipped"])(
    "accepts an exact exception for terminal selfie status %s",
    (extractionStatus) => {
      expect(currentManualKycException(
        { id: "exception-1", completedAt: approvedAt, data: evidence },
        {
          clientId: subject.id,
          subject,
          latestSelfie: {
            id: "selfie-1",
            deletedAt: null,
            contentSha256: sha256,
            extractionStatus,
          },
          biometricAssessment: { ok: false, reason: "face_not_detected" },
        },
      )).toEqual(evidence)
    },
  )

  it("counts Unicode code points like PostgreSQL instead of UTF-16 code units", () => {
    expect(parseManualKycExceptionEvidence({
      ...evidence,
      reason: "😀".repeat(10),
    })).toBeNull()
    expect(parseManualKycExceptionEvidence({
      ...evidence,
      reason: "😀".repeat(20),
    })).toMatchObject({ reason: "😀".repeat(20) })
  })

  it.each(["\t", "\n", "\u00a0", "\u2003", "\ufeff"])(
    "rejects reasonless evidence made from %s edge whitespace",
    (whitespace) => {
      expect(parseManualKycExceptionEvidence({
        ...evidence,
        reason: whitespace.repeat(20),
      })).toBeNull()
      expect(parseManualKycExceptionEvidence({
        ...evidence,
        approvedById: whitespace.repeat(20),
      })).toBeNull()
      expect(parseManualKycExceptionEvidence({
        ...evidence,
        approvedByEmail: whitespace.repeat(20),
      })).toBeNull()
    },
  )
})
