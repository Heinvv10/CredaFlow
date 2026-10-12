import { createHash } from "crypto"
import { describe, expect, it } from "vitest"
import { biometricSubjectFingerprint } from "@/lib/kyc/biometric-evidence"
import { deriveCompositeKycState } from "@/lib/kyc/document-state"
import {
  BLOCKING_SELFIE_CONDITIONS,
  currentInPersonKycVerification,
  matchesBlockingSelfie,
  parseInPersonKycVerificationEvidence,
  IN_PERSON_KYC_VERIFICATION_KIND,
  IN_PERSON_KYC_VERIFICATION_VERSION,
  type InPersonKycVerificationEvidence,
  type InPersonKycVerificationRecord,
} from "@/lib/kyc/in-person-verification"

const subject = {
  id: "client-1",
  idNumber: "8905310001088",
  firstName: "Dineo",
  lastName: "Testperson",
  dateOfBirth: new Date("1989-05-31T00:00:00.000Z"),
}

const sha = (seed: string) => createHash("sha256").update(seed).digest("hex")
const ID_SHA = sha("id-copy-bytes")
const APPROVED_AT = new Date("2026-07-27T13:00:00.000Z")

const NOTE = "Client attended Hendrina branch; face matched the ID photo."

function evidence(
  over: Partial<InPersonKycVerificationEvidence> = {},
): InPersonKycVerificationEvidence {
  return {
    kind: IN_PERSON_KYC_VERIFICATION_KIND,
    version: IN_PERSON_KYC_VERIFICATION_VERSION,
    clientId: "client-1",
    idDocumentId: "doc-id-copy",
    idDocumentSha256: ID_SHA,
    subjectFingerprint: biometricSubjectFingerprint(subject),
    method: "IN_PERSON_BRANCH",
    note: NOTE,
    approvedAt: APPROVED_AT.toISOString(),
    approvedById: "admin-1",
    approvedByEmail: "admin@acme-lending.example",
    ...over,
  }
}

const record = (data: unknown = evidence()): InPersonKycVerificationRecord => ({
  id: "compliance-1",
  completedAt: APPROVED_AT,
  data,
})

const idDocument = (over: Partial<{ id: string; contentSha256: string | null; deletedAt: Date | null; verified: boolean }> = {}) => ({
  id: "doc-id-copy",
  contentSha256: ID_SHA,
  deletedAt: null,
  verified: true,
  ...over,
})

const MISSING = { ok: false as const, reason: "biometric_evidence_missing" as const }

function current(over: Partial<Parameters<typeof currentInPersonKycVerification>[1]> = {}, rec = record()) {
  return currentInPersonKycVerification(rec, {
    clientId: "client-1",
    subject,
    idDocument: idDocument(),
    blockingBiometricAttempt: false,
    biometricAssessment: MISSING,
    latestSelfie: null,
    ...over,
  })
}

const refusedSelfie = (reason: string, idDocumentId?: unknown) => ({
  biometricResult: {
    biometricFailureReason: reason,
    ...(idDocumentId === undefined ? {} : { idDocumentId }),
  },
})

describe("parseInPersonKycVerificationEvidence", () => {
  it("accepts a well-formed attestation", () => {
    expect(parseInPersonKycVerificationEvidence(evidence())).not.toBeNull()
  })

  it.each([
    ["a foreign kind", { kind: "KYC_MANUAL_EXCEPTION" }],
    ["an unknown version", { version: "kyc-in-person-verification-v2" }],
    ["an unlisted method", { method: "PHONE_CALL" }],
    ["a note below the minimum", { note: "verified" }],
    ["a non-digest document hash", { idDocumentSha256: "not-a-sha" }],
    ["a non-digest fingerprint", { subjectFingerprint: "nope" }],
    ["an unparseable approval time", { approvedAt: "yesterday" }],
    ["no approver", { approvedById: "" }],
  ])("rejects %s", (_label, over) => {
    expect(
      parseInPersonKycVerificationEvidence({ ...evidence(), ...over }),
    ).toBeNull()
  })
})

describe("currentInPersonKycVerification", () => {
  it("holds while the attested circumstances still stand", () => {
    expect(current()).not.toBeNull()
  })

  it("does not cover a client with a live biometric attempt (processing or passed)", () => {
    expect(current({ blockingBiometricAttempt: true })).toBeNull()
  })

  it("SURVIVES a failed biometric attempt — the human fallback stays open", () => {
    // Regression: one failed selfie permanently closed the
    // in-person route, removing every path to payout-grade KYC.
    expect(current({
      blockingBiometricAttempt: false,
      biometricAssessment: { ok: false as const, reason: "match_score_below_threshold" as const },
    })).not.toBeNull()
  })

  it.each([
    ["the biometric is valid, making it moot", { biometricAssessment: { ok: true as const } }],
    ["the ID document was replaced", { idDocument: idDocument({ contentSha256: sha("different-bytes") }) }],
    ["the ID document row changed", { idDocument: idDocument({ id: "doc-other" }) }],
    ["the ID document was unverified", { idDocument: idDocument({ verified: false }) }],
    ["the ID document was deleted", { idDocument: idDocument({ deletedAt: new Date() }) }],
    ["there is no ID document at all", { idDocument: null }],
  ])("lapses when %s", (_label, over) => {
    expect(current(over)).toBeNull()
  })

  it("lapses when the client's identity is edited", () => {
    expect(
      current({ subject: { ...subject, idNumber: "9001015009087" } }),
    ).toBeNull()
  })

  it("lapses when the stored approval time is not the record's completion", () => {
    // Guards against a hand-edited data blob claiming an approval that the
    // compliance row itself does not corroborate.
    expect(
      current({}, { ...record(), completedAt: new Date("2026-07-26T13:00:00.000Z") }),
    ).toBeNull()
  })

  it("is inert without a completed compliance record", () => {
    expect(current({}, { ...record(), completedAt: null })).toBeNull()
    expect(currentInPersonKycVerification(null, {
      clientId: "client-1",
      subject,
      idDocument: idDocument(),
      blockingBiometricAttempt: false,
      biometricAssessment: MISSING,
      latestSelfie: null,
    })).toBeNull()
  })

  it.each([
    ["that names this ID copy", refusedSelfie("id_document_portrait_invalid", "doc-id-copy")],
    ["that names no ID copy", refusedSelfie("id_document_portrait_invalid")],
    ["that names an ID copy as a non-string", refusedSelfie("id_document_portrait_invalid", 7)],
  ])("lapses while the latest selfie refused the ID portrait, in a refusal %s", (_label, latestSelfie) => {
    expect(current({ latestSelfie })).toBeNull()
  })

  it.each([
    ["the refusal was of another ID copy", refusedSelfie("id_document_portrait_invalid", "doc-older-copy")],
    ["the selfie was refused as not a real photograph", refusedSelfie("selfie_not_real_photograph", "doc-id-copy")],
    ["the selfie failed for an exceptionable reason", refusedSelfie("face_not_detected", "doc-id-copy")],
    ["the latest selfie carries no evidence object", { biometricResult: null }],
  ])("holds when %s", (_label, latestSelfie) => {
    expect(current({ latestSelfie })).not.toBeNull()
  })

  it("does not accept a senior biometric exception in its place", () => {
    // Both live in the same ComplianceRecord type; only data.kind separates
    // them. A failed-attempt exception must not be read as an attestation.
    expect(current({}, record({ ...evidence(), kind: "KYC_MANUAL_EXCEPTION" }))).toBeNull()
  })
})

describe("composite KYC state with an in-person attestation", () => {
  const coreDocuments = [
    "ID_COPY", "PROOF_OF_ADDRESS", "PAYSLIP", "BANK_STATEMENT",
  ].map((docType, index) => ({
    id: `doc-${docType.toLowerCase()}`,
    docType,
    verified: true,
    verificationNote: null,
    createdAt: new Date(Date.UTC(2026, 6, 20, 0, index)),
  }))
  const pending = {
    kycStatus: "PENDING" as const,
    kycVerifiedAt: null,
    kycVerifiedById: null,
    kycVerificationMethod: null,
  }
  const completion = {
    verifiedAt: new Date("2026-07-27T12:00:00.000Z"),
    verifiedById: null,
    method: "SMILE_IDENTITY" as const,
  }

  function derive(inPersonVerification: InPersonKycVerificationEvidence | null) {
    return deriveCompositeKycState({
      documents: coreDocuments,
      biometricDocumentPresent: false,
      biometricAssessment: MISSING,
      existing: pending,
      completion,
      inPersonVerification,
    })
  }

  it("stays closed with no attestation, so a missing selfie still blocks", () => {
    const state = derive(null)
    expect(state.ok).toBe(false)
    expect(state.biometricEvidence).toBe("biometric_evidence_missing")
  })

  it("opens the gate and records it as PHYSICAL, never as a biometric pass", () => {
    const state = derive(evidence())
    expect(state.ok).toBe(true)
    expect(state.manualExceptionActive).toBe(true)
    expect(state.inPersonVerification).not.toBeNull()
    // The provenance must name the human who attested, not an automated check.
    expect(state.state.kycVerificationMethod).toBe("PHYSICAL")
    expect(state.state.kycVerifiedById).toBe("admin-1")
    expect(state.manualException).toBeNull()
  })

  it("cannot rescue a client who is still missing a core document", () => {
    const state = deriveCompositeKycState({
      documents: coreDocuments.filter((d) => d.docType !== "PAYSLIP"),
      biometricDocumentPresent: false,
      biometricAssessment: MISSING,
      existing: pending,
      completion,
      inPersonVerification: evidence(),
    })
    expect(state.ok).toBe(false)
    expect(state.missingCoreDocuments).toContain("PAYSLIP")
  })

  it("passes composite KYC for a failed selfie covered by an in-person attestation", () => {
    // The Anthony Collins shape: latest selfie failed, in-person recorded.
    const state = deriveCompositeKycState({
      documents: coreDocuments,
      biometricDocumentPresent: true,
      biometricAssessment: { ok: false, reason: "match_score_below_threshold" },
      existing: pending,
      completion,
      inPersonVerification: evidence(),
    })
    expect(state.ok).toBe(true)
    expect(state.substituteKind).toBe("in_person")
    expect(state.state.kycVerificationMethod).toBe("PHYSICAL")
  })

  it("never overrides an active manual KYC rejection", () => {
    const state = deriveCompositeKycState({
      documents: coreDocuments,
      biometricDocumentPresent: false,
      biometricAssessment: MISSING,
      existing: { ...pending, kycManualRejectionActive: true },
      completion,
      inPersonVerification: evidence(),
    })
    expect(state.ok).toBe(false)
    expect(state.manualRejectionActive).toBe(true)
    expect(state.manualExceptionActive).toBe(false)
  })
})

describe("matchesBlockingSelfie", () => {
  const live = {
    docType: "SELFIE",
    deletedAt: null,
    extractionStatus: "completed",
    verified: true,
    biometricVerifiedAt: new Date("2026-07-28T10:00:00.000Z"),
  }

  // This predicate and BLOCKING_SELFIE_CONDITIONS are one rule written twice —
  // once for Postgres, once for a caller holding the rows already. The SQL
  // half is exercised through the database; this is what holds the in-memory
  // half to the same truth table, leg by leg, so a dropped condition fails
  // here rather than quietly widening who counts as verified.
  it("blocks a provider-verified passing attempt", () => {
    expect(matchesBlockingSelfie(live)).toBe(true)
  })

  it("blocks an attempt still processing, verified or not", () => {
    expect(
      matchesBlockingSelfie({
        ...live,
        extractionStatus: "processing",
        verified: false,
        biometricVerifiedAt: null,
      }),
    ).toBe(true)
  })

  it("does NOT block a soft-deleted attempt", () => {
    // A deleted attempt must leave the in-person
    // route open, or a client whose selfie was withdrawn has no way through.
    expect(
      matchesBlockingSelfie({ ...live, deletedAt: new Date("2026-07-28T11:00:00.000Z") }),
    ).toBe(false)
  })

  it("does NOT block an unverified attempt carrying a biometric timestamp", () => {
    expect(matchesBlockingSelfie({ ...live, verified: false })).toBe(false)
  })

  it("does NOT block a verified attempt with no biometric timestamp", () => {
    expect(matchesBlockingSelfie({ ...live, biometricVerifiedAt: null })).toBe(false)
  })

  it("does NOT block a failed attempt", () => {
    expect(
      matchesBlockingSelfie({
        ...live,
        extractionStatus: "failed",
        verified: false,
        biometricVerifiedAt: null,
      }),
    ).toBe(false)
  })

  it("ignores a row that is not a selfie at all", () => {
    expect(matchesBlockingSelfie({ ...live, docType: "ID_COPY" })).toBe(false)
  })

  it("reads its document type from the shared where-shape", () => {
    // Not a tautology: it pins the two halves to ONE constant, so renaming the
    // enum member cannot leave the in-memory half matching a stale literal.
    expect(matchesBlockingSelfie({ ...live, docType: BLOCKING_SELFIE_CONDITIONS.docType }))
      .toBe(true)
  })
})
