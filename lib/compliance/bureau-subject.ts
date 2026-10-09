import { createHash } from "node:crypto"
import { buildExperianEnquiryInput } from "@/lib/integrations/experian-input"

export const BUREAU_SUBJECT_FINGERPRINT_VERSION = "experian-subject-v1" as const

export interface BureauSubjectClient {
  id: string
  idNumber: string
  firstName: string
  lastName: string
  gender: "MALE" | "FEMALE" | "OTHER" | null
  dateOfBirth: Date | null
}

function normalizedIdentityNumber(value: string): string {
  return String(value ?? "").normalize("NFKC").replace(/[\s-]/g, "").toUpperCase()
}

function normalizedName(value: string): string {
  return String(value ?? "")
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ")
    .toUpperCase()
}

/**
 * Hash the exact identity fields used for an Experian enquiry. Client id is
 * intentionally verified separately: the hash binds provider-facing subject
 * identity, while clientId prevents evidence reuse across client records.
 */
export function bureauSubjectFingerprint(client: BureauSubjectClient): string {
  const input = buildExperianEnquiryInput({
    idNumber: client.idNumber,
    firstName: client.firstName,
    lastName: client.lastName,
    gender: client.gender === "MALE" ? "M" : client.gender === "FEMALE" ? "F" : null,
    dateOfBirth: client.dateOfBirth,
    consentGranted: true,
    applicationId: "subject-fingerprint",
  })
  return createHash("sha256").update(JSON.stringify([
    BUREAU_SUBJECT_FINGERPRINT_VERSION,
    input.identityType,
    normalizedIdentityNumber(input.identityNumber),
    normalizedName(input.forename),
    normalizedName(input.surname),
    input.gender ?? null,
    input.dateOfBirth,
  ])).digest("hex")
}

export function bureauCheckMatchesSubject(
  check: { clientId: string; subjectFingerprint?: string | null },
  client: BureauSubjectClient,
): boolean {
  return check.clientId === client.id &&
    typeof check.subjectFingerprint === "string" &&
    check.subjectFingerprint.length === 64 &&
    check.subjectFingerprint === bureauSubjectFingerprint(client)
}
