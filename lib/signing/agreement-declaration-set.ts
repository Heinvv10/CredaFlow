/** Versioned copy of the five declarations already displayed by the portal. Legal review required before release. */
export const AGREEMENT_DECLARATION_VERSION = "portal-agreement-declarations-v1"
export const AGREEMENT_DECLARATIONS = [
  { id: "pasq_read", text: "I have read and understood this Pre-Agreement Statement and Quotation" },
  { id: "schedule_read", text: "I have read and understood the Repayment Schedule" },
  { id: "settlement_right", text: "I have been informed of my right to settle this agreement in full at any time (NCA Section 125)" },
  { id: "terms_accepted", text: "I accept the terms and conditions of this credit agreement" },
  { id: "information_true", text: "The information I have provided is true and correct" },
] as const
export const AGREEMENT_DECLARATION_SET_SHA256 = "94948b549e9415944b73909f0dce298c5b304e8ed4f832de4e14787e5452cfd7"
export const AGREEMENT_DECLARATION_IDS = AGREEMENT_DECLARATIONS.map(d => d.id)
export const AGREEMENT_DECLARATION_PAYLOAD = { version: AGREEMENT_DECLARATION_VERSION, setSha256: AGREEMENT_DECLARATION_SET_SHA256, acceptedIds: AGREEMENT_DECLARATION_IDS }
export function validAgreementDeclarations(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const v = value as Record<string, unknown>
  const ids = v.acceptedIds
  return v.version === AGREEMENT_DECLARATION_VERSION && v.setSha256 === AGREEMENT_DECLARATION_SET_SHA256 && Array.isArray(ids)
    && ids.length === AGREEMENT_DECLARATION_IDS.length
    && AGREEMENT_DECLARATION_IDS.every((id, index) => ids[index] === id)
}
