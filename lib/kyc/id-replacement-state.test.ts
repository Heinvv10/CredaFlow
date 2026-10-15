import { describe, expect, it } from "vitest"
import { deriveCompositeKycState } from "./document-state"

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
  verificationRejectedById: null as string | null,
  createdAt: new Date(Date.UTC(2026, 6, 20, 0, index)),
}))

const verifiedProjection = {
  kycStatus: "VERIFIED" as const,
  kycVerifiedAt: new Date("2026-07-22T10:00:00.000Z"),
  kycVerifiedById: "officer-1",
  kycVerificationMethod: "PHYSICAL" as const,
}

const replacement = {
  id: "doc-id_copy-new",
  docType: "ID_COPY",
  verified: false,
  verificationNote: null,
  verificationRejectedById: null as string | null,
  createdAt: new Date(Date.UTC(2026, 6, 21, 0, 0)),
}

function derive(extra: (typeof replacement)[]) {
  return deriveCompositeKycState({
    documents: [...verifiedCoreDocuments, ...extra],
    biometricDocumentPresent: true,
    biometricAssessment: { ok: true },
    existing: verifiedProjection,
    completion: {
      verifiedAt: new Date("2026-07-23T01:00:00.000Z"),
      verifiedById: null,
      method: "BIOMETRIC",
    },
    preserveVerifiedProvenance: true,
  })
}

describe("composite KYC state: a replacement ID copy awaiting review", () => {
  it("does not stay VERIFIED on the older copy while a newer one awaits review", () => {
    expect(derive([replacement])).toEqual(expect.objectContaining({
      ok: false,
      okForOrigination: false,
      missingCoreDocuments: ["ID_COPY"],
      coreDocumentGaps: [{ docType: "ID_COPY", state: "awaiting_verification" }],
      state: expect.objectContaining({ kycStatus: "PENDING", kycVerifiedAt: null }),
    }))
  })

  it("keeps the verified copy when a named reviewer refused the newer one", () => {
    expect(derive([{ ...replacement, verificationRejectedById: "officer-2" }])).toEqual(
      expect.objectContaining({
        ok: true,
        missingCoreDocuments: [],
        state: expect.objectContaining({ kycStatus: "VERIFIED" }),
      }),
    )
  })

  it("verifies again once the newer copy is verified", () => {
    expect(derive([{ ...replacement, verified: true }])).toEqual(expect.objectContaining({
      ok: true,
      state: expect.objectContaining({ kycStatus: "VERIFIED" }),
    }))
  })
})
