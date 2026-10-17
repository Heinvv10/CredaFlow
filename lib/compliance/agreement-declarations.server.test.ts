import { describe, expect, it } from "vitest"
import { assertDeclarationEvidence, declarationEvidenceData, signatureDigest } from "./agreement-declarations.server"
const binding = { tenantId: "synthetic", applicationId: "application", clientId: "client", signerId: "client", method: "portal", signedAt: new Date("2026-10-17T12:00:00Z"), agreementDocumentSha256: "a".repeat(64), pasqDocumentSha256: "b".repeat(64), signatureSha256: signatureDigest("Synthetic signature") }
describe("declaration artifact binding", () => {
  it("refuses a present record for another signature, document, client, tenant or re-sign time", () => {
    const record = { id: "record", ...declarationEvidenceData(binding) }
    expect(() => assertDeclarationEvidence(record, binding)).not.toThrow()
    for (const field of ["tenantId", "applicationId", "clientId", "signatureSha256", "agreementDocumentSha256", "pasqDocumentSha256"] as const) expect(() => assertDeclarationEvidence(record, { ...binding, [field]: "changed" })).toThrow(/does not match/)
    expect(() => assertDeclarationEvidence(record, { ...binding, signedAt: new Date(binding.signedAt.getTime() + 1) })).toThrow(/does not match/)
  })
})
