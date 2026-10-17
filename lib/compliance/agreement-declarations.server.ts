import { createHash } from "node:crypto"
import { validAgreementDeclarations, AGREEMENT_DECLARATION_PAYLOAD, AGREEMENT_DECLARATIONS, AGREEMENT_DECLARATION_SET_SHA256 } from "@/lib/signing/agreement-declaration-set"
export const signatureDigest = (value: string) => createHash("sha256").update(value).digest("hex")
export interface DeclarationBinding {
  tenantId: string; applicationId: string; clientId: string; signerId: string; method: string
  signedAt: Date; agreementDocumentSha256: string; pasqDocumentSha256: string; signatureSha256: string
}
export interface DeclarationEvidence extends DeclarationBinding { id: string; version: string; setSha256: string; acceptedIds: string[] }
export function declarationEvidenceData(binding: DeclarationBinding) {
  if (signatureDigest(JSON.stringify(AGREEMENT_DECLARATIONS)) !== AGREEMENT_DECLARATION_SET_SHA256) throw new Error("Declaration wording changed without a new version and digest")
  return { ...binding, ...AGREEMENT_DECLARATION_PAYLOAD, acceptedIds: [...AGREEMENT_DECLARATION_PAYLOAD.acceptedIds] } }
export function assertDeclarationEvidence(evidence: DeclarationEvidence, binding: DeclarationBinding): void {
  if (signatureDigest(JSON.stringify(AGREEMENT_DECLARATIONS)) !== evidence.setSha256 || !validAgreementDeclarations(evidence) || evidence.method !== "portal" || evidence.signerId !== evidence.clientId
    || Object.keys(binding).some(key => key === "signedAt"
      ? evidence.signedAt.getTime() !== binding.signedAt.getTime()
      : evidence[key as keyof DeclarationBinding] !== binding[key as keyof DeclarationBinding])) {
    throw new Error("Recorded declaration acceptance does not match this signature ceremony")
  }
}
