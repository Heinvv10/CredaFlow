import { createHash } from "crypto"
import { describe, expect, it } from "vitest"
import { biometricSubjectFingerprint } from "@/lib/kyc/biometric-evidence"
import { deriveCompositeKycState } from "@/lib/kyc/document-state"
import {
  BLOCKING_SELFIE_CONDITIONS,
  currentInPersonKycVerification,
  idDocumentPortraitRefused,
  matchesIdPortraitRefusal,
  inPersonAttestationIdempotencyKey,
  selfieBlocksInPersonVerification,
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

type TestAttempt = { biometricResult: unknown; createdAt: Date; deletedAt?: Date | null; extractionStatus?: string | null }

/** Attempts default to a live (not deleted), failed row, the usual shape of a recorded verdict. */
function current(
  over: Partial<Omit<Parameters<typeof currentInPersonKycVerification>[1], "selfieAttempts">> & { selfieAttempts?: TestAttempt[] } = {},
  rec = record(),
) {
  const { selfieAttempts = [], ...rest } = over
  return currentInPersonKycVerification(rec, {
    clientId: "client-1",
    subject,
    idDocument: idDocument(),
    blockingBiometricAttempt: false,
    biometricAssessment: MISSING,
    portraitRefusals: [],
    ...rest,
    selfieAttempts: selfieAttempts.map((attempt) => ({ deletedAt: null, extractionStatus: "failed", ...attempt })),
  })
}

// `undefined` omits idDocumentId; `null` omits idDocumentSha256 (which
// otherwise defaults to this copy's digest).
const refusedSelfie = (reason: string, idDocumentId?: unknown, idDocumentSha256: unknown = ID_SHA) => ({
  biometricResult: {
    biometricFailureReason: reason,
    ...(idDocumentId === undefined ? {} : { idDocumentId }),
    ...(idDocumentSha256 === null ? {} : { idDocumentSha256 }),
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

describe("selfieBlocksInPersonVerification", () => {
  const captured = new Date("2026-10-12T08:00:00.000Z")
  const after = new Date("2026-10-12T09:00:00.000Z")
  const passed = (idDocumentId?: unknown) => ({
    extractionStatus: "done",
    createdAt: captured,
    biometricResult: idDocumentId === undefined ? {} : { idDocumentId },
  })
  const currentCopies = [{ id: "doc-a", verificationRejectedAt: null, verificationRejectedById: null }]

  it.each([
    ["still processing", { ...passed("doc-gone"), extractionStatus: "processing" }, after],
    ["passed against a current copy", passed("doc-a"), after],
    ["passed naming no copy", passed(), after],
    ["passed against a gone copy, judged for an attestation from before it", passed("doc-gone"), new Date("2026-10-12T07:00:00.000Z")],
    ["passed against a gone copy, judged for an attestation at the same instant", passed("doc-gone"), captured],
    ["passed against a gone copy, judged for no attestation", passed("doc-gone"), null],
  ])("blocks a selfie %s", (_label, selfie, attestedAt) => {
    expect(selfieBlocksInPersonVerification(selfie, currentCopies, attestedAt)).toBe(true)
  })

  it.each([
    ["gone", "doc-gone", currentCopies],
    ["rejected", "doc-a", [{ ...currentCopies[0], verificationRejectedAt: captured }]],
    ["rejected by a named reviewer", "doc-a", [{ ...currentCopies[0], verificationRejectedById: "officer-1" }]],
  ])("releases a passed selfie whose copy is %s, for an attestation completed after it", (_label, named, copies) => {
    expect(selfieBlocksInPersonVerification(passed(named), copies, after)).toBe(false)
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
      portraitRefusals: [],
      selfieAttempts: [],
    })).toBeNull()
  })

  it.each([
    ["names this ID copy and its digest", [refusedSelfie("id_document_portrait_invalid", "doc-id-copy")]],
    ["names no ID copy (closes every copy)", [refusedSelfie("id_document_portrait_invalid", undefined, null)]],
    ["names this row but no digest", [refusedSelfie("id_document_portrait_invalid", "doc-id-copy", null)]],
    ["names the ID copy as a non-string", [refusedSelfie("id_document_portrait_invalid", 7, null)]],
    ["names this row but other bytes", [refusedSelfie("id_document_portrait_invalid", "doc-id-copy", sha("other-bytes"))]],
    ["names another row holding this copy's bytes", [refusedSelfie("id_document_portrait_invalid", "doc-reuploaded")]],
    ["names only this copy's digest", [refusedSelfie("id_document_portrait_invalid", undefined)]],
    ["sits among attempts that failed otherwise", [
      refusedSelfie("face_not_detected", "doc-id-copy"),
      refusedSelfie("id_document_portrait_invalid", "doc-id-copy"),
      refusedSelfie("selfie_not_real_photograph", "doc-id-copy"),
    ]],
  ])("lapses while any attempt refused the ID portrait in a refusal that %s", (_label, portraitRefusals) => {
    expect(current({ portraitRefusals })).toBeNull()
  })

  it.each([
    ["the refusal was of another ID copy, with other bytes", [refusedSelfie("id_document_portrait_invalid", "doc-older-copy", sha("other-bytes"))]],
    ["the refusal names only another digest", [refusedSelfie("id_document_portrait_invalid", undefined, sha("other-bytes"))]],
    ["the selfie was refused as not a real photograph", [refusedSelfie("selfie_not_real_photograph", "doc-id-copy")]],
    ["the selfie failed for an exceptionable reason", [refusedSelfie("face_not_detected", "doc-id-copy")]],
    ["an attempt carries no evidence object", [{ biometricResult: null }]],
  ])("holds when %s", (_label, portraitRefusals) => {
    expect(current({ portraitRefusals })).not.toBeNull()
  })

  it.each([
    ["a named digest", "doc-other-row", ID_SHA],
    ["no digest either", "doc-other-row", null],
  ])("matches a refusal of another row naming %s against a copy with no digest to nothing, as SQL's `=` against NULL", (_label, id, digest) => {
    expect(idDocumentPortraitRefused(
      [refusedSelfie("id_document_portrait_invalid", id, digest)],
      { id: "doc-id-copy", contentSha256: null },
    )).toBe(false)
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


describe("lapse on a later face verdict or an unknown outcome", () => {
  const at = (offsetMs: number) => new Date(APPROVED_AT.getTime() + offsetMs)
  const attempt = (offsetMs: number, over: Record<string, unknown> = {}, createdAt = at(offsetMs)) => ({
    createdAt,
    biometricResult: {
      verdictRecordedAt: at(offsetMs).toISOString(),
      idDocumentId: "doc-id-copy",
      faceVerdict: { samePerson: "different" },
      ...over,
    },
  })
  const benign = (offsetMs: number) => ({
    createdAt: at(offsetMs),
    biometricResult: { biometricFailureReason: "extraction_incomplete", verdictRecordedAt: at(offsetMs).toISOString() },
  })

  it("lapses when an adverse verdict was recorded after the attestation", () => {
    expect(current({ selfieAttempts: [attempt(1_000)] })).toBeNull()
  })

  it("is not rescued by a later benign-failing retake: the verdict is read on ANY attempt", () => {
    expect(current({ selfieAttempts: [attempt(1_000), benign(2_000)] })).toBeNull()
    expect(current({ selfieAttempts: [benign(2_000), attempt(1_000)] })).toBeNull()
  })

  it.each([
    ["recorded before the attestation", attempt(-1_000)],
    ["about another ID copy", attempt(1_000, { idDocumentId: "doc-old" })],
    ["a passing answer", attempt(1_000, { faceVerdict: { samePerson: "same", faceMatch: true } })],
    ["no stamp", { createdAt: at(1_000), biometricResult: { idDocumentId: "doc-id-copy", faceVerdict: { samePerson: "different" } } }],
    ["a malformed stamp", attempt(1_000, { verdictRecordedAt: "2099-01-01 00:00:00" })],
  ])("stands for a verdict %s", (_name, selfieAttempt) => {
    expect(current({ selfieAttempts: [selfieAttempt] })).not.toBeNull()
  })

  it.each([
    ["recorded in the same millisecond as the attestation (cannot be ordered)", attempt(0)],
    ["naming no ID copy at all (fail closed)", { createdAt: at(1_000), biometricResult: { verdictRecordedAt: at(1_000).toISOString(), faceVerdict: { samePerson: "different" } } }],
  ])("lapses for a verdict %s", (_name, selfieAttempt) => {
    expect(current({ selfieAttempts: [selfieAttempt] })).toBeNull()
  })

  it("lapses for a swept attempt whose reason a late answer replaced (the sweptAt marker)", () => {
    const swept = { biometricResult: { biometricFailureReason: "subject_identity_changed", sweptAt: at(500).toISOString() } }
    expect(current({ selfieAttempts: [{ ...swept, createdAt: at(1_000) }] })).toBeNull()
    expect(current({ selfieAttempts: [{ ...swept, createdAt: at(-1_000) }] })).not.toBeNull()
    expect(current({ selfieAttempts: [{ biometricResult: { sweptAt: 5 }, createdAt: at(1_000) }] })).not.toBeNull()
  })

  it("keeps an ID-portrait refusal the worker gave behind a replaced reason", () => {
    const refusal = (over: Record<string, unknown>) => ({
      biometricResult: { biometricFailureReason: "subject_identity_changed", workerFailureReason: "id_document_portrait_invalid", ...over },
    })
    expect(current({ portraitRefusals: [refusal({ idDocumentId: "doc-id-copy" })] })).toBeNull()
    expect(current({ portraitRefusals: [refusal({ idDocumentId: "doc-other", idDocumentSha256: "9".repeat(64) })] })).not.toBeNull()
    expect(idDocumentPortraitRefused([refusal({})], { id: "doc-id-copy", contentSha256: ID_SHA })).toBe(true)
    expect(matchesIdPortraitRefusal(refusal({}))).toBe(true)
    expect(matchesIdPortraitRefusal({ biometricResult: { workerFailureReason: "face_not_detected" } })).toBe(false)
  })

  it("lapses for an attempt deleted while still pending or processing (no writer touches it again)", () => {
    const deleted = (extractionStatus: string, createdAt: Date) => ({
      biometricResult: null, createdAt, deletedAt: at(2_000), extractionStatus,
    })
    for (const status of ["pending", "processing"]) {
      expect(current({ selfieAttempts: [deleted(status, at(1_000))] })).toBeNull()
      // Created before the attestation: staff attested knowing it was in flight.
      expect(current({ selfieAttempts: [deleted(status, at(-1_000))] })).not.toBeNull()
    }
    // Deleted after it finished, or never deleted, is not an unknown outcome.
    expect(current({ selfieAttempts: [deleted("failed", at(1_000))] })).not.toBeNull()
    expect(current({ selfieAttempts: [{ ...deleted("processing", at(1_000)), deletedAt: null }] })).not.toBeNull()
  })

  it("lapses for ANY attempt with an unknown outcome created after the attestation", () => {
    const unknown = { biometricResult: { biometricFailureReason: "biometric_outcome_not_recorded" } }
    expect(current({ selfieAttempts: [{ ...unknown, createdAt: at(1_000) }] })).toBeNull()
    expect(current({ selfieAttempts: [{ ...unknown, createdAt: at(-1_000) }] })).not.toBeNull()
    expect(current({ selfieAttempts: [{ ...unknown, createdAt: at(0) }] })).toBeNull()
    expect(current({
      selfieAttempts: [{ biometricResult: { biometricFailureReason: "face_not_detected" }, createdAt: at(1_000) }],
    })).not.toBeNull()
  })
})

describe("inPersonAttestationIdempotencyKey", () => {
  const base = {
    clientId: "client-1",
    idDocument: { id: "doc-id-copy", contentSha256: ID_SHA },
    subjectFingerprint: "f".repeat(64),
  }

  it("names the circumstances attested to", () => {
    expect(inPersonAttestationIdempotencyKey({ ...base, latestAttempt: null }))
      .toBe(`kyc-in-person:client-1:doc-id-copy:${ID_SHA}:${"f".repeat(64)}:no-selfie`)
  })

  it("changes when the latest attempt's verdict is recorded, so a re-attestation after a lapse is a new key", () => {
    const swept = { id: "selfie-1", biometricResult: { swept: true } }
    const stamped = { id: "selfie-1", biometricResult: { verdictRecordedAt: "2026-10-14T10:00:00.123Z" } }
    const keyOf = (latestAttempt: typeof swept | typeof stamped) => inPersonAttestationIdempotencyKey({ ...base, latestAttempt })
    expect(keyOf(stamped)).not.toBe(keyOf(swept))
    expect(keyOf(stamped)).toBe(`${keyOf(swept)}:2026-10-14T10:00:00.123Z`)
  })
})
