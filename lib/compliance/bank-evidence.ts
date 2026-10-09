import { createHash } from "node:crypto"

export const BANK_EVIDENCE_FINGERPRINT_VERSION = "bank-evidence-v1" as const

export interface BankEvidenceTuple {
  bankName: string | null
  bankAccountNumber: string | null
  bankBranchCode: string | null
  accountType: string | null
}

function normalizedText(value: unknown): string {
  return String(value ?? "")
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ")
    .toUpperCase()
}

function normalizedIdentifier(value: unknown): string {
  return normalizedText(value).replace(/[\s-]/g, "")
}

export function bankEvidenceFingerprint(tuple: BankEvidenceTuple): string {
  return createHash("sha256").update(JSON.stringify([
    BANK_EVIDENCE_FINGERPRINT_VERSION,
    normalizedText(tuple.bankName),
    normalizedIdentifier(tuple.bankAccountNumber),
    normalizedIdentifier(tuple.bankBranchCode),
    normalizedText(tuple.accountType),
  ])).digest("hex")
}

export function bankEvidenceAuditValue(tuple: BankEvidenceTuple) {
  const accountNumber = normalizedIdentifier(tuple.bankAccountNumber)
  return {
    fingerprintVersion: BANK_EVIDENCE_FINGERPRINT_VERSION,
    fingerprint: bankEvidenceFingerprint(tuple),
    bankName: normalizedText(tuple.bankName) || null,
    accountNumberMasked: accountNumber
      ? `${"*".repeat(Math.max(0, accountNumber.length - 4))}${accountNumber.slice(-4)}`
      : null,
    branchCode: normalizedIdentifier(tuple.bankBranchCode) || null,
    accountType: normalizedText(tuple.accountType) || null,
  }
}
