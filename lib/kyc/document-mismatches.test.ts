import { describe, expect, it } from "vitest"
import { unresolvedNonBiometricDocumentMismatchWhere } from "./document-mismatches"

describe("unresolvedNonBiometricDocumentMismatchWhere", () => {
  it("excludes selfies because biometric evidence is governed by the ordered KYC state machine", () => {
    expect(
      unresolvedNonBiometricDocumentMismatchWhere({
        tenantId: "tenant-1",
        clientId: "client-1",
      }),
    ).toEqual({
      tenantId: "tenant-1",
      clientId: "client-1",
      deletedAt: null,
      docType: { not: "SELFIE" },
      validationMismatch: true,
      verified: false,
    })
  })
})
