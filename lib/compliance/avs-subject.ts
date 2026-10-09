import { createHash } from "node:crypto"

export const AVS_SUBJECT_FINGERPRINT_VERSION = "avs-subject-v1" as const

export interface AvsSubjectClient {
  id: string
  idNumber: string
  firstName: string
  lastName: string
  bankName: string | null
  bankBranchCode: string | null
  bankAccountNumber: string | null
  accountType: string | null
}

function normalizedText(value: string | null): string {
  return String(value ?? "")
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ")
    .toUpperCase()
}

function normalizedIdentifier(value: string | null): string {
  return normalizedText(value).replace(/[\s-]/g, "")
}

/** Hash every identity and bank-account field sent to the AVS provider. */
export function avsSubjectFingerprint(client: AvsSubjectClient): string {
  return createHash("sha256").update(JSON.stringify([
    AVS_SUBJECT_FINGERPRINT_VERSION,
    normalizedIdentifier(client.idNumber),
    normalizedText(client.firstName),
    normalizedText(client.lastName),
    normalizedText(client.bankName),
    normalizedIdentifier(client.bankBranchCode),
    normalizedIdentifier(client.bankAccountNumber),
    normalizedText(client.accountType),
  ])).digest("hex")
}

export function avsCheckMatchesSubject(
  check: { clientId: string; subjectFingerprint?: string | null },
  client: AvsSubjectClient,
): boolean {
  return check.clientId === client.id &&
    typeof check.subjectFingerprint === "string" &&
    check.subjectFingerprint.length === 64 &&
    check.subjectFingerprint === avsSubjectFingerprint(client)
}
