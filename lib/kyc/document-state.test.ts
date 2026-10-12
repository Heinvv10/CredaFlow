import { describe, expect, it } from "vitest"
import {
  clientKycAuditValue,
  deriveCompositeKycState,
  deriveCoreDocumentKycState,
  isCoreKycDocumentType,
  latestSelfieOrder,
  readCompositeKycState,
  type CompositeKycReader,
} from "./document-state"
import {
  MANUAL_KYC_EXCEPTION_KIND,
  MANUAL_KYC_EXCEPTION_VERSION,
  type ManualKycExceptionEvidence,
} from "./manual-exception"
import { biometricSubjectFingerprint } from "./biometric-evidence"

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
