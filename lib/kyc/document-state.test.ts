import { describe, expect, it } from "vitest"
import {
  clientKycAuditValue,
  deriveCompositeKycState,
  deriveCoreDocumentKycState,
  isCoreKycDocumentType,
  latestSelfieOrder,
  readCompositeKycState,
  type CompositeKycReader,
  type CoreKycDocumentRow,
} from "./document-state"
import {
  MANUAL_KYC_EXCEPTION_KIND,
  MANUAL_KYC_EXCEPTION_VERSION,
  type ManualKycExceptionEvidence,
} from "./manual-exception"
import { biometricSubjectFingerprint } from "./biometric-evidence"
import { PASSING_FACE_MODEL_EVIDENCE } from "./face-model/evidence.test-helpers"
import { inPersonKycVerificationOffered } from "./in-person-verification"

const verifiedCoreDocuments = [
  "ID_COPY",
  "PROOF_OF_ADDRESS",
  "PAYSLIP",
  "BANK_STATEMENT",
].map((docType, index) => ({
  id: `doc-${docType.toLowerCase()}`,
  docType,
  verified: true,
  verificationNote: null,
  // The classifier picks the CURRENT row per type, so fixtures need a time.
  createdAt: new Date(Date.UTC(2026, 6, 20, 0, index)),
}))

/**
 * The reader selects more than deriveCoreDocumentKycState needs: an in-person
 * attestation binds to the ID row's identity and digest. A fixture without
 * them silently starves that branch, so it never executes under test.
 */
const readerCoreDocuments = verifiedCoreDocuments.map((document, index) => ({
  ...document,
  id: `doc-${document.docType.toLowerCase()}`,
  contentSha256: "c".repeat(64),
  createdAt: new Date(Date.UTC(2026, 6, 20, 0, index)),
}))

describe("core-document KYC state", () => {
  it("records complete manual evidence as PHYSICAL with its verification time", () => {
    const verifiedAt = new Date("2026-07-21T10:00:00.000Z")

    const state = deriveCoreDocumentKycState(verifiedCoreDocuments, verifiedAt, "officer-1")

    expect(state).toEqual({
      kycStatus: "VERIFIED",
      kycVerifiedAt: verifiedAt,
      kycVerifiedById: "officer-1",
      kycVerificationMethod: "PHYSICAL",
    })
    expect(clientKycAuditValue(state)).toEqual({
      kycStatus: "VERIFIED",
      kycVerifiedAt: "2026-07-21T10:00:00.000Z",
      kycVerifiedById: "officer-1",
      kycVerificationMethod: "PHYSICAL",
    })
  })

  it("clears verification provenance when a required document is absent", () => {
    expect(deriveCoreDocumentKycState(verifiedCoreDocuments.slice(0, -1))).toEqual({
      kycStatus: "PENDING",
      kycVerifiedAt: null,
      kycVerifiedById: null,
      kycVerificationMethod: null,
    })
  })

  it("reports FAILED only for a rejection a named reviewer authored", () => {
    expect(deriveCoreDocumentKycState([
      ...verifiedCoreDocuments.slice(0, -1),
      {
        docType: "BANK_STATEMENT", verified: false,
        verificationNote: "Account mismatch", verificationRejectedById: "officer-1",
      },
    ])).toEqual({
      kycStatus: "FAILED",
      kycVerifiedAt: null,
      kycVerifiedById: null,
      kycVerificationMethod: null,
    })
  })

  it("reports PENDING for a note the system wrote, with no reviewer behind it", () => {
    expect(deriveCoreDocumentKycState([
      ...verifiedCoreDocuments.slice(0, -1),
      {
        docType: "BANK_STATEMENT", verified: false,
        verificationNote: "Bank details changed; verify this document against the current account before disbursement.",
        verificationRejectedById: null,
      },
    ]).kycStatus).toBe("PENDING")
  })

  it("does not treat selfies or generated documents as core KYC evidence", () => {
    expect(isCoreKycDocumentType("BANK_STATEMENT")).toBe(true)
    expect(isCoreKycDocumentType("SELFIE")).toBe(false)
    expect(isCoreKycDocumentType("CREDIT_AGREEMENT")).toBe(false)
  })
})

describe("composite KYC state", () => {
  const pending = {
    kycStatus: "PENDING" as const,
    kycVerifiedAt: null,
    kycVerifiedById: null,
    kycVerificationMethod: null,
  }
  const completion = {
    verifiedAt: new Date("2026-07-23T01:00:00.000Z"),
    verifiedById: null,
    method: "SMILE_IDENTITY" as const,
  }

  it("requires both the latest valid biometric and all four core documents", () => {
    expect(deriveCompositeKycState({
      documents: verifiedCoreDocuments,
      biometricDocumentPresent: false,
      biometricAssessment: { ok: false, reason: "biometric_evidence_missing" },
      existing: pending,
      completion,
    })).toEqual(expect.objectContaining({
      ok: false,
      biometricEvidence: "biometric_evidence_missing",
      missingCoreDocuments: [],
      coreDocumentGaps: [],
      state: expect.objectContaining({ kycStatus: "PENDING" }),
    }))

    expect(deriveCompositeKycState({
      documents: verifiedCoreDocuments.slice(0, -1),
      biometricDocumentPresent: true,
      biometricAssessment: { ok: true },
      existing: pending,
      completion,
    })).toEqual(expect.objectContaining({
      ok: false,
      biometricEvidence: null,
      missingCoreDocuments: ["BANK_STATEMENT"],
      state: expect.objectContaining({ kycStatus: "PENDING" }),
    }))
  })

  it("projects a match bound to an ID copy that is not the newest verified one as PENDING, not a failure", () => {
    expect(deriveCompositeKycState({
      documents: verifiedCoreDocuments,
      biometricDocumentPresent: true,
      biometricAssessment: { ok: false, reason: "subject_identity_changed", idDocumentNotCurrent: true },
      existing: pending,
      completion,
    })).toEqual(expect.objectContaining({
      ok: false,
      okForOrigination: true,
      biometricAttemptFailed: false,
      biometricIdDocumentNotCurrent: true,
      biometricAwaitingIdVerification: false,
      biometricEvidence: "subject_identity_changed",
      state: expect.objectContaining({ kycStatus: "PENDING" }),
    }))
  })

  it("projects a match against the current, unverified ID copy as PENDING with origination blocked", () => {
    const awaiting = { ok: false as const, reason: "subject_identity_changed" as const, idDocumentAwaitingVerification: true as const }
    // Not reachable through the reader (awaiting implies no verified ID copy,
    // so the ID copy is outstanding), but the derivation closes origination
    // on the awaiting state by itself.
    expect(deriveCompositeKycState({
      documents: verifiedCoreDocuments,
      biometricDocumentPresent: true,
      biometricAssessment: awaiting,
      existing: pending,
      completion,
    })).toEqual(expect.objectContaining({
      ok: false,
      okForOrigination: false,
      biometricAttemptFailed: false,
      biometricAwaitingIdVerification: true,
      biometricIdDocumentNotCurrent: false,
      biometricEvidence: "subject_identity_changed",
      state: expect.objectContaining({ kycStatus: "PENDING" }),
    }))
    // The new copy is the client's only one: the ID copy is outstanding too.
    expect(deriveCompositeKycState({
      documents: verifiedCoreDocuments.map((document) =>
        document.docType === "ID_COPY" ? { ...document, verified: false } : document),
      biometricDocumentPresent: true,
      biometricAssessment: awaiting,
      existing: pending,
      completion,
    })).toEqual(expect.objectContaining({
      ok: false,
      okForOrigination: false,
      biometricAttemptFailed: false,
      biometricAwaitingIdVerification: true,
      missingCoreDocuments: ["ID_COPY"],
      state: expect.objectContaining({ kycStatus: "PENDING" }),
    }))
    // A manual rejection still governs.
    expect(deriveCompositeKycState({
      documents: verifiedCoreDocuments,
      biometricDocumentPresent: true,
      biometricAssessment: awaiting,
      existing: {
        ...pending,
        kycManualRejectionActive: true,
        kycManualRejectionAt: new Date("2026-07-23T00:00:00.000Z"),
        kycManualRejectionById: "officer-1",
        kycManualRejectionReason: "Synthetic hold",
      },
      completion,
    })).toEqual(expect.objectContaining({
      okForOrigination: false,
      state: expect.objectContaining({ kycStatus: "FAILED" }),
    }))
  })

  it("never leaves origination closed under a strict pass a substitute carries", () => {
    // Unreachable through the reader (the awaiting reason is not exceptionable
    // and the passed selfie blocks the in-person route), but the derivation
    // must keep ok implying okForOrigination for any input.
    const result = deriveCompositeKycState({
      documents: verifiedCoreDocuments,
      biometricDocumentPresent: true,
      biometricAssessment: { ok: false, reason: "subject_identity_changed", idDocumentAwaitingVerification: true },
      existing: pending,
      completion,
      manualException: {
        kind: MANUAL_KYC_EXCEPTION_KIND,
        version: MANUAL_KYC_EXCEPTION_VERSION,
        clientId: "client-1",
        documentId: "selfie-1",
        documentSha256: "a".repeat(64),
        subjectFingerprint: "b".repeat(64),
        biometricFailureReason: "face_not_detected",
        reason: "Senior reviewed the failed attempt and accepted physical evidence.",
        supportingEvidence: "Physical ID comparison was completed by the senior reviewer.",
        approvedAt: "2026-07-23T03:00:00.000Z",
        approvedById: "admin-1",
        approvedByEmail: "admin@example.test",
      },
    })
    expect(result).toEqual(expect.objectContaining({
      ok: true, okForOrigination: true, biometricAwaitingIdVerification: false,
    }))
  })

  it("still projects an identity change found by the subject fingerprint as FAILED", () => {
    expect(deriveCompositeKycState({
      documents: verifiedCoreDocuments,
      biometricDocumentPresent: true,
      biometricAssessment: { ok: false, reason: "subject_identity_changed" },
      existing: pending,
      completion,
    })).toEqual(expect.objectContaining({
      ok: false,
      okForOrigination: false,
      biometricAttemptFailed: true,
      biometricIdDocumentNotCurrent: false,
      state: expect.objectContaining({ kycStatus: "FAILED" }),
    }))
  })

  it("projects VERIFIED only for the complete composite evidence set", () => {
    expect(deriveCompositeKycState({
      documents: verifiedCoreDocuments,
      biometricDocumentPresent: true,
      biometricAssessment: { ok: true },
      existing: pending,
      completion,
    })).toEqual({
      ok: true,
      biometricEvidence: null,
      manualRejectionActive: false,
      okForOrigination: true,
      biometricAttemptFailed: false,
      biometricIdDocumentNotCurrent: false,
      biometricAwaitingIdVerification: false,
      manualExceptionActive: false,
      substituteKind: null,
      manualException: null,
      inPersonVerification: null,
      missingCoreDocuments: [],
      coreDocumentGaps: [],
      state: {
        kycStatus: "VERIFIED",
        kycVerifiedAt: completion.verifiedAt,
        kycVerifiedById: null,
        kycVerificationMethod: "SMILE_IDENTITY",
      },
    })
  })

  it("keeps a manual rejection distinct and authoritative over valid evidence", () => {
    expect(deriveCompositeKycState({
      documents: verifiedCoreDocuments,
      biometricDocumentPresent: true,
      biometricAssessment: { ok: true },
      existing: {
        ...pending,
        kycStatus: "FAILED",
        kycManualRejectionActive: true,
        kycManualRejectionAt: new Date("2026-07-23T01:30:00.000Z"),
        kycManualRejectionById: "officer-1",
        kycManualRejectionReason: "Identity evidence requires investigation",
      },
      completion,
    })).toEqual({
      ok: false,
      biometricEvidence: null,
      manualRejectionActive: true,
      okForOrigination: false,
      biometricAttemptFailed: false,
      biometricIdDocumentNotCurrent: false,
      biometricAwaitingIdVerification: false,
      manualExceptionActive: false,
      substituteKind: null,
      manualException: null,
      inPersonVerification: null,
      missingCoreDocuments: [],
      coreDocumentGaps: [],
      state: {
        kycStatus: "FAILED",
        kycVerifiedAt: null,
        kycVerifiedById: null,
        kycVerificationMethod: null,
      },
    })
  })

  it("accepts a bound senior exception without relabelling it as biometric success", () => {
    const manualException: ManualKycExceptionEvidence = {
      kind: MANUAL_KYC_EXCEPTION_KIND,
      version: MANUAL_KYC_EXCEPTION_VERSION,
      clientId: "client-1",
      documentId: "selfie-1",
      documentSha256: "a".repeat(64),
      subjectFingerprint: "b".repeat(64),
      biometricFailureReason: "face_not_detected",
      reason: "Senior reviewed the failed attempt and accepted physical evidence.",
      supportingEvidence: "Physical ID comparison was completed by the senior reviewer.",
      approvedAt: "2026-07-23T03:00:00.000Z",
      approvedById: "admin-1",
      approvedByEmail: "admin@example.test",
    }

    expect(deriveCompositeKycState({
      documents: verifiedCoreDocuments,
      biometricDocumentPresent: true,
      biometricAssessment: { ok: false, reason: "face_not_detected" },
      existing: pending,
      completion,
      manualException,
    })).toEqual({
      ok: true,
      biometricEvidence: "face_not_detected",
      manualRejectionActive: false,
      okForOrigination: true,
      biometricAttemptFailed: false,
      biometricIdDocumentNotCurrent: false,
      biometricAwaitingIdVerification: false,
      manualExceptionActive: true,
      substituteKind: "senior_exception",
      manualException,
      inPersonVerification: null,
      missingCoreDocuments: [],
      coreDocumentGaps: [],
      state: {
        kycStatus: "VERIFIED",
        kycVerifiedAt: new Date(manualException.approvedAt),
        kycVerifiedById: "admin-1",
        kycVerificationMethod: "PHYSICAL",
      },
    })
  })

  it("preserves coherent provider provenance when redundant core evidence is removed", () => {
    const smileVerified = {
      kycStatus: "VERIFIED" as const,
      kycVerifiedAt: new Date("2026-07-22T09:00:00.000Z"),
      kycVerifiedById: null,
      kycVerificationMethod: "SMILE_IDENTITY" as const,
    }
    expect(deriveCompositeKycState({
      documents: verifiedCoreDocuments,
      biometricDocumentPresent: true,
      biometricAssessment: { ok: true },
      existing: smileVerified,
      completion: {
        verifiedAt: new Date("2026-07-23T02:00:00.000Z"),
        verifiedById: null,
        method: "PHYSICAL",
      },
      preserveVerifiedProvenance: true,
    }).state).toEqual(smileVerified)
  })

  it("preserves VLM face-match provenance the same way — BIOMETRIC verifies with no staff actor", () => {
    // Regression: coherentVerifiedProvenance accepted only SMILE_IDENTITY as
    // a valid null-verifiedById method, so VLM-verified rows lost their
    // provenance on any preserve-provenance re-derivation.
    const vlmVerified = {
      kycStatus: "VERIFIED" as const,
      kycVerifiedAt: new Date("2026-07-28T18:00:00.000Z"),
      kycVerifiedById: null,
      kycVerificationMethod: "BIOMETRIC" as const,
    }
    expect(deriveCompositeKycState({
      documents: verifiedCoreDocuments,
      biometricDocumentPresent: true,
      biometricAssessment: { ok: true },
      existing: vlmVerified,
      completion: {
        verifiedAt: new Date("2026-07-29T02:00:00.000Z"),
        verifiedById: null,
        method: "PHYSICAL",
      },
      preserveVerifiedProvenance: true,
    }).state).toEqual(vlmVerified)
  })
})

describe("latest biometric attempt ordering", () => {
  it("uses the database attempt sequence before timestamp and id fallbacks", () => {
    expect(latestSelfieOrder()).toEqual([
      { biometricAttemptSequence: "desc" },
      { createdAt: "desc" },
      { id: "desc" },
    ])
  })
})

describe("why each core document is outstanding", () => {
  const at = (iso: string) => new Date(iso)
  const base = {
    biometricDocumentPresent: false,
    biometricAssessment: { ok: false as const, reason: "biometric_evidence_missing" as const },
    existing: {
      kycStatus: "PENDING" as const,
      kycVerifiedAt: null,
      kycVerifiedById: null,
      kycVerificationMethod: null,
    },
    completion: {
      verifiedAt: at("2026-07-27T12:00:00.000Z"),
      verifiedById: null,
      method: "SMILE_IDENTITY" as const,
    },
  }
  const verified = (docType: string, iso = "2026-07-20T00:00:00.000Z") =>
    ({ id: `doc-${docType.toLowerCase()}`, docType, verified: true, verificationNote: null, createdAt: at(iso) })

  it("classifies absent, unreviewed and flagged documents differently", () => {
    const state = deriveCompositeKycState({
      ...base,
      documents: [
        verified("ID_COPY"),
        { id: "doc-proof_of_address-21", docType: "PROOF_OF_ADDRESS", verified: false, verificationNote: null, createdAt: at("2026-07-21T00:00:00.000Z") },
        { id: "doc-bank_statement-21", docType: "BANK_STATEMENT", verified: false, verificationNote: "Statement is illegible", createdAt: at("2026-07-21T00:00:00.000Z") },
        // PAYSLIP absent entirely
      ],
    })

    expect(state.coreDocumentGaps).toEqual([
      { docType: "PROOF_OF_ADDRESS", state: "awaiting_verification" },
      { docType: "PAYSLIP", state: "not_uploaded" },
      { docType: "BANK_STATEMENT", state: "flagged" },
    ])
  })

  it("does not keep flagging a document the client has already re-uploaded", () => {
    // Refused, then re-uploaded. The outstanding action is a REVIEW, not
    // another upload; telling staff otherwise sends them to chase a client
    // who has already complied.
    const state = deriveCompositeKycState({
      ...base,
      documents: [
        verified("ID_COPY"), verified("PROOF_OF_ADDRESS"), verified("PAYSLIP"),
        { id: "doc-bank_statement-21", docType: "BANK_STATEMENT", verified: false, verificationNote: "Statement is illegible", createdAt: at("2026-07-21T00:00:00.000Z") },
        { id: "doc-bank_statement-26", docType: "BANK_STATEMENT", verified: false, verificationNote: null, createdAt: at("2026-07-26T00:00:00.000Z") },
      ],
    })

    expect(state.coreDocumentGaps).toEqual([
      { docType: "BANK_STATEMENT", state: "awaiting_verification" },
    ])
  })

  it("still flags when the newest upload is the one carrying the note", () => {
    const state = deriveCompositeKycState({
      ...base,
      documents: [
        verified("ID_COPY"), verified("PROOF_OF_ADDRESS"), verified("PAYSLIP"),
        { id: "doc-bank_statement-21", docType: "BANK_STATEMENT", verified: false, verificationNote: null, createdAt: at("2026-07-21T00:00:00.000Z") },
        { id: "doc-bank_statement-26", docType: "BANK_STATEMENT", verified: false, verificationNote: "Still illegible", createdAt: at("2026-07-26T00:00:00.000Z") },
      ],
    })

    expect(state.coreDocumentGaps).toEqual([{ docType: "BANK_STATEMENT", state: "flagged" }])
  })

  it("does not call a system re-verification flag a rejection", () => {
    // Changing a client's bank details re-flags a previously VERIFIED
    // statement with a system-authored note (app/api/clients/[id]/route.ts).
    // Nobody rejected anything and no new upload is required.
    const state = deriveCompositeKycState({
      ...base,
      documents: [
        verified("ID_COPY"), verified("PROOF_OF_ADDRESS"), verified("PAYSLIP"),
        {
          id: "doc-bank-system-flag",
          docType: "BANK_STATEMENT", verified: false, createdAt: at("2026-07-21T00:00:00.000Z"),
          verificationNote: "Bank details changed; verify this document against the current account before disbursement.",
        },
      ],
    })

    expect(state.coreDocumentGaps).toEqual([{ docType: "BANK_STATEMENT", state: "flagged" }])
  })

  it("classifies the same tied rows identically whichever order they arrive in", () => {
    // createdAt is @default(now()) and Postgres freezes now() per transaction,
    // so two rows of one docType written together tie EXACTLY. The reader's
    // findMany has no orderBy, so without a tiebreak the winner would be
    // whichever row came back first.
    const tie = at("2026-07-21T00:00:00.000Z")
    const clean = { id: "doc-a", docType: "BANK_STATEMENT", verified: false, verificationNote: null, createdAt: tie }
    const noted = { id: "doc-b", docType: "BANK_STATEMENT", verified: false, verificationNote: "Illegible", createdAt: tie }
    const core = [verified("ID_COPY"), verified("PROOF_OF_ADDRESS"), verified("PAYSLIP")]

    const forwards = deriveCompositeKycState({ ...base, documents: [...core, clean, noted] })
    const backwards = deriveCompositeKycState({ ...base, documents: [...core, noted, clean] })

    expect(forwards.coreDocumentGaps).toEqual(backwards.coreDocumentGaps)
  })

  it("reports no gaps once every core document is verified", () => {
    const state = deriveCompositeKycState({
      ...base,
      documents: [
        verified("ID_COPY"), verified("PROOF_OF_ADDRESS"),
        verified("PAYSLIP"), verified("BANK_STATEMENT"),
      ],
    })

    expect(state.coreDocumentGaps).toEqual([])
  })
})

describe("who refused a document decides whether the CLIENT failed", () => {
  const base = {
    existing: { kycStatus: "PENDING" as const, kycVerifiedAt: null, kycVerifiedById: null, kycVerificationMethod: null },
    completion: { verifiedAt: new Date("2026-07-27T12:00:00.000Z"), verifiedById: null, method: "SMILE_IDENTITY" as const },
    biometricDocumentPresent: false,
    biometricAssessment: { ok: false as const, reason: "biometric_evidence_missing" as const },
  }
  const doc = (docType: string, over: Record<string, unknown> = {}) => ({
    id: `doc-${docType.toLowerCase()}`, docType, verified: true,
    verificationNote: null, verificationRejectedById: null,
    createdAt: new Date("2026-07-20T00:00:00.000Z"), ...over,
  })
  const withBankStatement = (over: Record<string, unknown>) => deriveCompositeKycState({
    ...base,
    documents: [doc("ID_COPY"), doc("PROOF_OF_ADDRESS"), doc("PAYSLIP"), doc("BANK_STATEMENT", over)],
  })

  it("fails the client when a named reviewer refused a core document", () => {
    const state = withBankStatement({
      verified: false,
      verificationNote: "Statement is illegible",
      verificationRejectedById: "officer-1",
    })

    expect(state.state.kycStatus).toBe("FAILED")
    expect(state.coreDocumentGaps).toEqual([{ docType: "BANK_STATEMENT", state: "rejected" }])
  })

  it("does not fail the client when the SYSTEM re-flagged the same document", () => {
    // Identical row shape apart from the author. Changing bank details writes
    // this note with no reviewer; nobody refused anything.
    const state = withBankStatement({
      verified: false,
      verificationNote: "Bank details changed; verify this document against the current account before disbursement.",
      verificationRejectedById: null,
    })

    expect(state.state.kycStatus).toBe("PENDING")
    expect(state.coreDocumentGaps).toEqual([{ docType: "BANK_STATEMENT", state: "flagged" }])
  })

  it("stops failing the client once the refusal is superseded by a fresh upload", () => {
    const state = deriveCompositeKycState({
      ...base,
      documents: [
        doc("ID_COPY"), doc("PROOF_OF_ADDRESS"), doc("PAYSLIP"),
        doc("BANK_STATEMENT", {
          id: "doc-bank-old", verified: false, verificationNote: "Illegible",
          verificationRejectedById: "officer-1", createdAt: new Date("2026-07-21T00:00:00.000Z"),
        }),
        doc("BANK_STATEMENT", {
          id: "doc-bank-new", verified: false, verificationNote: null,
          verificationRejectedById: null, createdAt: new Date("2026-07-26T00:00:00.000Z"),
        }),
      ],
    })

    expect(state.state.kycStatus).toBe("PENDING")
    expect(state.coreDocumentGaps).toEqual([{ docType: "BANK_STATEMENT", state: "awaiting_verification" }])
  })
})

describe("composite KYC exception reader", () => {
  it("binds the latest compliance record to the exact failed selfie", async () => {
    const subject = {
      id: "client-1",
      idNumber: "9912310000085",
      firstName: "Synthetic",
      lastName: "Customer",
      dateOfBirth: new Date("1999-12-31T00:00:00.000Z"),
    }
    const approvedAt = new Date("2026-07-23T04:00:00.000Z")
    const manualException: ManualKycExceptionEvidence = {
      kind: MANUAL_KYC_EXCEPTION_KIND,
      version: MANUAL_KYC_EXCEPTION_VERSION,
      clientId: subject.id,
      documentId: "selfie-1",
      documentSha256: "a".repeat(64),
      subjectFingerprint: biometricSubjectFingerprint(subject),
      biometricFailureReason: "face_not_detected",
      reason: "Senior accepted the physical identity evidence after review.",
      supportingEvidence: "ID copy and physical comparison were completed.",
      approvedAt: approvedAt.toISOString(),
      approvedById: "admin-1",
      approvedByEmail: "admin@example.test",
    }
    const reader = {
      clientDocument: {
        // No attempt refused an ID portrait.
        findMany: (async (args: { where: { docType?: unknown } }) => (
          args.where.docType === "SELFIE" ? [] : readerCoreDocuments
        )) as unknown as CompositeKycReader["clientDocument"]["findMany"],
        findFirst: async () => ({
          id: "selfie-1",
          contentSha256: "a".repeat(64),
          deletedAt: null,
          verified: false,
          extractionStatus: "failed",
          extractionResult: null,
          extractionError: "No face",
          validationMismatch: true,
          validationScore: 0,
          biometricMatchScore: null,
          biometricLiveness: null,
          biometricVerifiedAt: null,
          biometricResult: { biometricFailureReason: "face_not_detected" },
        }),
      },
      complianceRecord: {
        findFirst: async () => ({
          id: "exception-1",
          completedAt: approvedAt,
          data: manualException,
        }),
      },
    }

    const result = await readCompositeKycState(reader, {
      tenantId: "tenant-1",
      clientId: subject.id,
      subject,
      existing: {
        ...subject,
        kycStatus: "VERIFIED",
        kycVerifiedAt: approvedAt,
        kycVerifiedById: "admin-1",
        kycVerificationMethod: "PHYSICAL",
      },
      preserveVerifiedProvenance: true,
    })

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      latestSelfieId: "selfie-1",
      biometricEvidence: "face_not_detected",
      manualExceptionActive: true,
      manualException,
      state: {
        kycStatus: "VERIFIED",
        kycVerifiedAt: approvedAt,
        kycVerifiedById: "admin-1",
        kycVerificationMethod: "PHYSICAL",
      },
    }))
  })
})

describe("composite KYC reader: a selfie matched against the client's first, unverified ID copy", () => {
  const subject = {
    id: "client-awaiting",
    idNumber: "9001015009087",
    firstName: "Synthetic",
    lastName: "Borrower",
    dateOfBirth: new Date("1990-01-01T00:00:00.000Z"),
  }
  const verifiedA: CoreKycDocumentRow = {
    ...readerCoreDocuments[0],
    id: "id-copy-A",
    contentSha256: "a".repeat(64),
    verificationRejectedAt: null,
    verificationRejectedById: null,
    createdAt: new Date("2026-07-20T08:00:00.000Z"),
  }
  const currentB = {
    ...verifiedA,
    id: "id-copy-B",
    contentSha256: "b".repeat(64),
    verified: false,
    createdAt: new Date("2026-07-21T08:00:00.000Z"),
  }
  const selfieCreatedAt = new Date("2026-07-21T09:00:00.000Z")
  const passedAgainstB = {
    id: "selfie-B",
    contentSha256: "e".repeat(64),
    deletedAt: null,
    verified: true,
    extractionStatus: "done",
    extractionResult: {
      faceDetected: { value: true }, facesCount: { value: 1 }, isLive: { value: true }, quality: { value: "good" },
    },
    extractionError: null,
    validationMismatch: false,
    validationScore: 90,
    biometricMatchScore: 90,
    biometricLiveness: 95,
    biometricVerifiedAt: selfieCreatedAt,
    biometricResult: {
      ok: true, verified: true, matchScore: 90, livenessScore: 95,
      provider: "vlm-face-match-v3", idPhotoKind: "photograph", idPhotoIsRealPhotograph: true,
      idPhotoFaceDetected: true, selfieIsRealPhotograph: true, samePerson: "same", faceMatch: true,
      matchConfidence: 0.9, livenessConfidence: 0.95, faceModel: PASSING_FACE_MODEL_EVIDENCE,
      idDocumentId: currentB.id, idDocumentSha256: currentB.contentSha256,
      subjectFingerprint: biometricSubjectFingerprint(subject),
    },
  }
  const otherCore = readerCoreDocuments.slice(1).map((document) => ({
    ...document, verificationRejectedAt: null, verificationRejectedById: null,
  }))

  function reader(idCopies: readonly CoreKycDocumentRow[]): CompositeKycReader {
    return {
      clientDocument: {
        findMany: (async (args: { where: { docType?: unknown; OR?: unknown } }) => {
          if (args.where.docType !== "SELFIE") return [...idCopies, ...otherCore]
          // The passed selfie is a blocking candidate; nothing refused a portrait.
          return args.where.OR
            ? [{ extractionStatus: "done", biometricResult: passedAgainstB.biometricResult, createdAt: selfieCreatedAt }]
            : []
        }) as unknown as CompositeKycReader["clientDocument"]["findMany"],
        findFirst: async () => passedAgainstB,
      },
    }
  }

  const read = (idCopies: readonly CoreKycDocumentRow[]) => readCompositeKycState(reader(idCopies), {
    tenantId: "tenant-1",
    clientId: subject.id,
    subject,
    existing: { kycStatus: "PENDING", kycVerifiedAt: null, kycVerifiedById: null, kycVerificationMethod: null },
  })

  it("awaits ID verification, origination blocked, and does not offer the in-person route the selfie closes", async () => {
    const result = await read([currentB])
    expect(result).toEqual(expect.objectContaining({
      ok: false,
      okForOrigination: false,
      biometricAttemptFailed: false,
      biometricAwaitingIdVerification: true,
      awaitingIdDocumentId: currentB.id,
      missingCoreDocuments: ["ID_COPY"],
      state: expect.objectContaining({ kycStatus: "PENDING" }),
    }))
    // The route refuses (409) while this passed selfie names a current copy.
    expect(result.inPersonRoute.blockingBiometricAttempt).toBe(true)
    expect(inPersonKycVerificationOffered({
      manualExceptionActive: result.manualExceptionActive,
      inPersonVerificationRecorded: result.inPersonVerification !== null,
      coreDocumentsComplete: result.missingCoreDocuments.length === 0,
      manualRejectionActive: result.manualRejectionActive,
      ...result.inPersonRoute,
    })).toBe(false)
  })

  it.each([
    // L1 shape: a verified A is on file and the match ran against a newer B.
    ["a verified copy A is on file", [verifiedA, currentB]],
    ["staff rejected B", [{ ...currentB, verificationRejectedAt: new Date("2026-07-22T08:00:00.000Z"), verificationRejectedById: "officer-1" }]],
    ["B was deleted", []],
    ["a later upload buried B", [currentB, { ...currentB, id: "id-copy-C", contentSha256: "c".repeat(64), createdAt: new Date("2026-07-22T08:00:00.000Z") }]],
  ] as const)("projects FAILED with origination blocked once %s", async (_label, idCopies) => {
    expect(await read(idCopies)).toEqual(expect.objectContaining({
      okForOrigination: false,
      biometricAttemptFailed: true,
      biometricAwaitingIdVerification: false,
      awaitingIdDocumentId: null,
      state: expect.objectContaining({ kycStatus: "FAILED" }),
    }))
  })

  it("verifies the client once staff verify B", async () => {
    expect(await read([{ ...currentB, verified: true }])).toEqual(expect.objectContaining({
      ok: true,
      okForOrigination: true,
      biometricAwaitingIdVerification: false,
      state: expect.objectContaining({ kycStatus: "VERIFIED", kycVerificationMethod: "BIOMETRIC" }),
    }))
  })
})
