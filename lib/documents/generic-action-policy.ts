const LOCKED_STATUTORY_EVIDENCE_TYPES = new Set([
  "CREDIT_AGREEMENT",
  // The artifact carrying BOTH signatures. It is the only document that shows
  // the consumer actually signed, so it is at least as load-bearing as the
  // unsigned one it derives from.
  "EXECUTED_CREDIT_AGREEMENT",
  "FORM_20_PRE_AGREEMENT",
  "DEBIT_MANDATE",
  // The returned packet the consumer physically signed. It was filed as OTHER
  // until 2026-08-05, which left it deletable and verifiable through the
  // generic paths — and a prod row reached verified=true while its
  // signatureState was still 'returned_pending_recording', a combination the
  // signing route never writes. Verification of this artifact happens inside
  // the recording transaction, against the digest, or not at all.
  "SIGNED_AGREEMENT_PACKET",
])

export function isLockedStatutoryEvidence(docType: string): boolean {
  return LOCKED_STATUTORY_EVIDENCE_TYPES.has(docType)
}

export function genericDocumentActionPolicy(docType: string) {
  const lockedStatutoryEvidence = isLockedStatutoryEvidence(docType)

  return {
    lockedStatutoryEvidence,
    badgeLabel: lockedStatutoryEvidence ? "Locked statutory evidence" : null,
    showGenericValidation: !lockedStatutoryEvidence,
    showGenericExtraction: !lockedStatutoryEvidence,
    canVerify: !lockedStatutoryEvidence,
    canExtract: !lockedStatutoryEvidence,
    canDelete: !lockedStatutoryEvidence,
  }
}
