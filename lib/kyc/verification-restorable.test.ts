import { describe, expect, it } from "vitest"
import { deriveCompositeKycState } from "./document-state"
import { newestVerifiedIdCopyId, verificationRestorable } from "./verification-restorable"

const coreDocuments = ["ID_COPY", "PROOF_OF_ADDRESS", "PAYSLIP", "BANK_STATEMENT"].map((docType, index) => ({
  id: `doc-${docType.toLowerCase()}`,
  docType,
  verified: true,
  verificationNote: null,
  verificationRejectedById: null as string | null,
  createdAt: new Date(Date.UTC(2026, 6, 20, 0, index)),
  contentSha256: docType === "ID_COPY" ? "a".repeat(64) : "b".repeat(64),
}))
const pendingReplacement = {
  ...coreDocuments[0], id: "doc-id_copy-new", verified: false,
  createdAt: new Date(Date.UTC(2026, 6, 21)), contentSha256: "f".repeat(64),
}
const pendingProjection = {
  kycStatus: "PENDING" as const, kycVerifiedAt: null, kycVerifiedById: null, kycVerificationMethod: null,
}

const noManualPending = { manualPendingStands: false }

function composite(documents: typeof coreDocuments, existing: Record<string, unknown> = {}) {
  return deriveCompositeKycState({
    documents,
    biometricDocumentPresent: true,
    biometricAssessment: { ok: true },
    existing: { ...pendingProjection, ...existing },
    completion: { verifiedAt: new Date("2026-07-23T01:00:00.000Z"), verifiedById: null, method: "BIOMETRIC" },
    preserveVerifiedProvenance: true,
  })
}

describe("verificationRestorable", () => {
  it("is true when the stored status is PENDING but the evidence derives VERIFIED", () => {
    // e.g. the client withdrew the replacement ID; the delete never promotes.
    expect(verificationRestorable("PENDING", composite(coreDocuments), noManualPending)).toBe(true)
  })

  it("is false while a replacement ID still awaits review", () => {
    expect(verificationRestorable("PENDING", composite([...coreDocuments, pendingReplacement]), noManualPending)).toBe(false)
  })

  it("is false while a different copy awaits review behind a newer identical re-upload", () => {
    const identicalNewest = {
      ...pendingReplacement, id: "doc-id_copy-same", createdAt: new Date(Date.UTC(2026, 6, 22)), contentSha256: "a".repeat(64),
    }
    expect(verificationRestorable("PENDING", composite([...coreDocuments, pendingReplacement, identicalNewest]), noManualPending)).toBe(false)
  })

  it("is false when the evidence is incomplete", () => {
    expect(verificationRestorable("PENDING", composite(coreDocuments.slice(1)), noManualPending)).toBe(false)
  })

  it("is false under an active manual rejection", () => {
    expect(verificationRestorable("PENDING", composite(coreDocuments, { kycManualRejectionActive: true }), noManualPending)).toBe(false)
  })

  it("is false while a staff member's deliberate manual PENDING is the latest status change", () => {
    // The evidence would verify, but staff chose PENDING; the hint must not undo that.
    expect(verificationRestorable("PENDING", composite(coreDocuments), { manualPendingStands: true })).toBe(false)
  })

  it.each(["VERIFIED", "FAILED", "EXPIRED"])("is false when the stored status is %s", (stored) => {
    expect(verificationRestorable(stored, composite(coreDocuments), noManualPending)).toBe(false)
  })
})

describe("newestVerifiedIdCopyId", () => {
  const listed = (id: string, createdAt: string, extra: Record<string, unknown> = {}) =>
    ({ id, docType: "ID_COPY", verified: true, deletedAt: null, createdAt, ...extra })

  it("picks the newest verified, non-deleted ID copy, as the composite rule does", () => {
    expect(newestVerifiedIdCopyId([
      listed("id-newest-unverified", "2026-07-03T00:00:00Z", { verified: false }),
      listed("id-deleted", "2026-07-04T00:00:00Z", { deletedAt: "2026-07-05T00:00:00Z" }),
      listed("id-old", "2026-07-01T00:00:00Z"),
      listed("id-current", "2026-07-02T00:00:00Z"),
      listed("poa", "2026-07-06T00:00:00Z", { docType: "PROOF_OF_ADDRESS" }),
    ])).toBe("id-current")
  })

  it("breaks a createdAt tie on id in code units, descending", () => {
    const at = "2026-07-02T00:00:00Z"
    expect(newestVerifiedIdCopyId([listed("id-B", at), listed("id-a", at)])).toBe("id-a")
  })

  it("is null with no verified ID copy", () => {
    expect(newestVerifiedIdCopyId([listed("id-x", "2026-07-02T00:00:00Z", { verified: false })])).toBeNull()
  })
})
