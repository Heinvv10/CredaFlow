import { createHash } from "node:crypto"
import { isSha256Digest } from "@/lib/documents/content-integrity"

export interface StoredProviderCountersign {
  id: unknown
  tenantId: unknown
  clientId: unknown
  agreementGeneratedAt: unknown
  agreementDocumentSha256: unknown
  agreementSignedAt: unknown
  agreementSignedMethod: unknown
  agreementSignedByUserId: unknown
  agreementSignatureData: unknown
  agreementCountersignedAt: unknown
  agreementCountersignedById: unknown
  agreementCountersignedByName: unknown
  agreementCountersignedByEmail: unknown
  agreementCountersignatureData: unknown
  agreementCountersignatureSha256: unknown
  agreementCountersignatureEnvelopeSha256: unknown
  agreementCountersignedDocumentSha256: unknown
}

export type ProviderCountersignVerification =
  | {
      ok: true
      evidence: {
        countersignedAt: Date
        countersignedById: string
        countersignedByName: string
        countersignedByEmail: string
        signatureData: string
        signatureSha256: string
        envelopeSha256: string
        consumerSignatureSha256: string
        documentSha256: string
      }
    }
  | {
      ok: false
      reason:
        | "missing"
        | "incomplete"
        | "invalid_timestamps"
        | "document_changed"
        | "consumer_signature_missing"
        | "consumer_signature_identity"
        | "signature_hash_mismatch"
        | "envelope_hash_mismatch"
    }

function asDate(value: unknown): Date | null {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) return null
  return value
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

export function providerCountersignatureSha256(signatureData: string): string {
  return createHash("sha256").update(signatureData).digest("hex")
}

interface ProviderCountersignatureEnvelope {
  tenantId: string
  applicationId: string
  clientId: string
  documentSha256: string
  consumerSignedAt: Date
  consumerSignedMethod: "portal" | "branch"
  consumerSignerId: string
  consumerSignatureSha256: string
  providerCountersignedAt: Date
  providerSignerId: string
  providerSignerName: string
  providerSignerEmail: string
  providerSignatureSha256: string
}

export function providerCountersignatureEnvelopeSha256(
  envelope: ProviderCountersignatureEnvelope,
): string {
  // Hex every variable UTF-8 field before joining. The database guard
  // reproduces this byte-for-byte, so a direct writer cannot invent an
  // arbitrary 64-character envelope digest and bypass the application
  // verifier. Hex encoding also makes the delimiter unambiguous.
  const encoded = [
    envelope.tenantId,
    envelope.applicationId,
    envelope.clientId,
    envelope.documentSha256,
    envelope.consumerSignedAt.toISOString(),
    envelope.consumerSignedMethod,
    envelope.consumerSignerId,
    envelope.consumerSignatureSha256,
    envelope.providerCountersignedAt.toISOString(),
    envelope.providerSignerId,
    envelope.providerSignerName,
    envelope.providerSignerEmail,
    envelope.providerSignatureSha256,
  ].map((value) => Buffer.from(value, "utf8").toString("hex"))

  return createHash("sha256").update([
    "provider-countersign-envelope-v3",
    ...encoded,
  ].join(":")).digest("hex")
}

export function verifyStoredProviderCountersign(
  stored: StoredProviderCountersign,
): ProviderCountersignVerification {
  const countersignedAt = asDate(stored.agreementCountersignedAt)
  const countersignedById = nonEmptyString(stored.agreementCountersignedById)
  const countersignedByName = nonEmptyString(stored.agreementCountersignedByName)
  const countersignedByEmail = nonEmptyString(stored.agreementCountersignedByEmail)
  const signatureData = nonEmptyString(stored.agreementCountersignatureData)
  const signatureSha256 = nonEmptyString(stored.agreementCountersignatureSha256)
  const envelopeSha256 = nonEmptyString(
    stored.agreementCountersignatureEnvelopeSha256,
  )
  const countersignedDocumentSha256 = nonEmptyString(
    stored.agreementCountersignedDocumentSha256,
  )

  const evidenceValues = [
    countersignedAt,
    countersignedById,
    countersignedByName,
    countersignedByEmail,
    signatureData,
    signatureSha256,
    envelopeSha256,
    countersignedDocumentSha256,
  ]
  if (evidenceValues.every((value) => value === null)) {
    return { ok: false, reason: "missing" }
  }
  if (evidenceValues.some((value) => value === null)) {
    return { ok: false, reason: "incomplete" }
  }

  const agreementGeneratedAt = asDate(stored.agreementGeneratedAt)
  const agreementSignedAt = asDate(stored.agreementSignedAt)
  if (
    !agreementGeneratedAt
    || !agreementSignedAt
    || agreementSignedAt < agreementGeneratedAt
    || countersignedAt! < agreementSignedAt
  ) {
    return { ok: false, reason: "invalid_timestamps" }
  }

  const tenantId = nonEmptyString(stored.tenantId)
  const applicationId = nonEmptyString(stored.id)
  const clientId = nonEmptyString(stored.clientId)
  const consumerSignedMethod = nonEmptyString(stored.agreementSignedMethod)
  const consumerSignedByUserId = nonEmptyString(stored.agreementSignedByUserId)
  const consumerSignatureData = nonEmptyString(stored.agreementSignatureData)
  if (!consumerSignatureData) {
    return { ok: false, reason: "consumer_signature_missing" }
  }
  if (
    !tenantId
    || !applicationId
    || !clientId
    || (consumerSignedMethod !== "portal" && consumerSignedMethod !== "branch")
  ) {
    return { ok: false, reason: "consumer_signature_identity" }
  }
  const consumerSignerId = consumerSignedMethod === "portal"
    ? clientId
    : consumerSignedByUserId
  if (!consumerSignerId) {
    return { ok: false, reason: "consumer_signature_identity" }
  }

  if (
    !isSha256Digest(stored.agreementDocumentSha256)
    || !isSha256Digest(countersignedDocumentSha256)
    || countersignedDocumentSha256 !== stored.agreementDocumentSha256
  ) {
    return { ok: false, reason: "document_changed" }
  }
  if (
    !isSha256Digest(signatureSha256)
    || providerCountersignatureSha256(signatureData!) !== signatureSha256
  ) {
    return { ok: false, reason: "signature_hash_mismatch" }
  }
  const consumerSignatureSha256 =
    providerCountersignatureSha256(consumerSignatureData)
  const expectedEnvelopeSha256 = providerCountersignatureEnvelopeSha256({
    tenantId,
    applicationId,
    clientId,
    documentSha256: countersignedDocumentSha256,
    consumerSignedAt: agreementSignedAt,
    consumerSignedMethod,
    consumerSignerId,
    consumerSignatureSha256,
    providerCountersignedAt: countersignedAt!,
    providerSignerId: countersignedById!,
    providerSignerName: countersignedByName!,
    providerSignerEmail: countersignedByEmail!,
    providerSignatureSha256: signatureSha256,
  })
  if (
    !isSha256Digest(envelopeSha256)
    || envelopeSha256 !== expectedEnvelopeSha256
  ) {
    return { ok: false, reason: "envelope_hash_mismatch" }
  }

  return {
    ok: true,
    evidence: {
      countersignedAt: countersignedAt!,
      countersignedById: countersignedById!,
      countersignedByName: countersignedByName!,
      countersignedByEmail: countersignedByEmail!,
      signatureData: signatureData!,
      signatureSha256,
      envelopeSha256,
      consumerSignatureSha256,
      documentSha256: countersignedDocumentSha256,
    },
  }
}
