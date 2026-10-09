import { describe, expect, it } from "vitest"
import {
  providerCountersignatureEnvelopeSha256,
  providerCountersignatureSha256,
  verifyStoredProviderCountersign,
} from "./provider-countersign"

const signatureData = "Jane Provider"
const documentSha256 = "d".repeat(64)
const evidenceWithoutEnvelope = {
  id: "app-1",
  tenantId: "tenant-1",
  clientId: "client-1",
  agreementGeneratedAt: new Date("2026-07-23T08:00:00.000Z"),
  agreementDocumentSha256: documentSha256,
  agreementSignedAt: new Date("2026-07-23T08:30:00.000Z"),
  agreementSignedMethod: "portal",
  agreementSignedByUserId: null,
  agreementSignatureData: "Jane Consumer",
  agreementCountersignedAt: new Date("2026-07-23T08:45:00.000Z"),
  agreementCountersignedById: "staff-1",
  agreementCountersignedByName: "Jane Provider",
  agreementCountersignedByEmail: "jane@example.test",
  agreementCountersignatureData: signatureData,
  agreementCountersignatureSha256: providerCountersignatureSha256(signatureData),
  agreementCountersignedDocumentSha256: documentSha256,
}
const evidence = {
  ...evidenceWithoutEnvelope,
  agreementCountersignatureEnvelopeSha256:
    providerCountersignatureEnvelopeSha256({
      tenantId: evidenceWithoutEnvelope.tenantId,
      applicationId: evidenceWithoutEnvelope.id,
      clientId: evidenceWithoutEnvelope.clientId,
      documentSha256,
      consumerSignedAt: evidenceWithoutEnvelope.agreementSignedAt,
      consumerSignedMethod: "portal",
      consumerSignerId: evidenceWithoutEnvelope.clientId,
      consumerSignatureSha256: providerCountersignatureSha256(
        evidenceWithoutEnvelope.agreementSignatureData,
      ),
      providerCountersignedAt: evidenceWithoutEnvelope.agreementCountersignedAt,
      providerSignerId: evidenceWithoutEnvelope.agreementCountersignedById,
      providerSignerName: evidenceWithoutEnvelope.agreementCountersignedByName,
      providerSignerEmail: evidenceWithoutEnvelope.agreementCountersignedByEmail,
      providerSignatureSha256:
        evidenceWithoutEnvelope.agreementCountersignatureSha256,
    }),
}

describe("provider countersign evidence", () => {
  it("accepts complete evidence bound to the exact signed agreement", () => {
    expect(verifyStoredProviderCountersign(evidence)).toEqual({
      ok: true,
      evidence: expect.objectContaining({
        countersignedById: "staff-1",
        signatureSha256: providerCountersignatureSha256(signatureData),
        consumerSignatureSha256: providerCountersignatureSha256("Jane Consumer"),
        envelopeSha256: evidence.agreementCountersignatureEnvelopeSha256,
        documentSha256,
      }),
    })
  })

  it("distinguishes missing, partial, stale-document, and forged signature evidence", () => {
    const empty = Object.fromEntries(
      Object.keys(evidence).map((key) => [key, key.startsWith("agreementCounter") ? null : evidence[key as keyof typeof evidence]]),
    )
    expect(verifyStoredProviderCountersign(empty as never)).toEqual({ ok: false, reason: "missing" })
    expect(verifyStoredProviderCountersign({
      ...evidence,
      agreementCountersignatureSha256: null,
    })).toEqual({ ok: false, reason: "incomplete" })
    expect(verifyStoredProviderCountersign({
      ...evidence,
      agreementDocumentSha256: "a".repeat(64),
    })).toEqual({ ok: false, reason: "document_changed" })
    expect(verifyStoredProviderCountersign({
      ...evidence,
      agreementCountersignatureSha256: "a".repeat(64),
    })).toEqual({ ok: false, reason: "signature_hash_mismatch" })
    expect(verifyStoredProviderCountersign({
      ...evidence,
      agreementSignatureData: null,
    })).toEqual({ ok: false, reason: "consumer_signature_missing" })
    expect(verifyStoredProviderCountersign({
      ...evidence,
      agreementCountersignatureEnvelopeSha256: "a".repeat(64),
    })).toEqual({ ok: false, reason: "envelope_hash_mismatch" })
    expect(verifyStoredProviderCountersign({
      ...evidence,
      tenantId: "tenant-2",
    })).toEqual({ ok: false, reason: "envelope_hash_mismatch" })
  })

  it("rejects countersigning before the consumer signature", () => {
    expect(verifyStoredProviderCountersign({
      ...evidence,
      agreementCountersignedAt: new Date("2026-07-23T08:15:00.000Z"),
    })).toEqual({ ok: false, reason: "invalid_timestamps" })
  })
})
