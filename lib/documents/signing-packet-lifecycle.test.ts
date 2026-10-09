import { describe, it, expect } from "vitest"
import {
  signingPacketLifecycle,
  type SigningPacketLifecycleInput,
} from "./signing-packet-lifecycle"

const AGREEMENT_SHA = "a".repeat(64)
const PASQ_SHA = "b".repeat(64)

function application(
  over: Partial<SigningPacketLifecycleInput> = {},
): SigningPacketLifecycleInput {
  return {
    applicationId: "app_1",
    reference: "APP-0001",
    agreementGeneratedAt: new Date("2026-08-05T10:00:00Z"),
    agreementDocumentSha256: AGREEMENT_SHA,
    pasqDocumentSha256: PASQ_SHA,
    agreementSignedAt: null,
    agreementCountersignedAt: null,
    agreementExecutedDocumentId: null,
    returnedPacket: null,
    ...over,
  }
}

function returnedPacket(over: Partial<{
  id: string
  boundAgreementSha256: string | null
  boundPasqSha256: string | null
  signatureState: string | null
}> = {}) {
  return {
    id: "doc_returned",
    boundAgreementSha256: AGREEMENT_SHA,
    boundPasqSha256: PASQ_SHA,
    signatureState: "returned_pending_recording",
    ...over,
  }
}

describe("signingPacketLifecycle", () => {
  it("has nothing to offer before the packet is prepared", () => {
    const result = signingPacketLifecycle(
      application({ agreementGeneratedAt: null }),
    )
    expect(result.state).toBe("not_issued")
    expect(result.downloadUrl).toBeNull()
    expect(result.documentId).toBeNull()
  })

  // The live concatenation endpoint, never a stored copy. A stored copy has to
  // be superseded on every agreement regeneration, and a missed supersession
  // serves a stale-but-official-looking document for signature.
  it("serves the live packet endpoint while awaiting signature", () => {
    const result = signingPacketLifecycle(application())
    expect(result.state).toBe("awaiting_signature")
    expect(result.downloadUrl).toBe("/api/applications/app_1/signing-packet")
    expect(result.documentId).toBeNull()
  })

  describe("a returned packet that has not been recorded", () => {
    it("offers the returned copy, not the live packet", () => {
      const result = signingPacketLifecycle(
        application({ returnedPacket: returnedPacket() }),
      )
      expect(result.state).toBe("returned_pending_recording")
      expect(result.downloadUrl).toBe("/api/documents/doc_returned/view")
      expect(result.documentId).toBe("doc_returned")
    })

    // Every downstream gate reads agreementSignedAt, which is still null here.
    // Describing this as signed on the surface staff read before disbursing
    // would be a false compliance claim.
    it("does not describe the application as signed", () => {
      const result = signingPacketLifecycle(
        application({ returnedPacket: returnedPacket() }),
      )
      expect(result.headline).toMatch(/not yet recorded/i)
      expect(result.headline).not.toMatch(/^signed by the consumer/i)
      expect(result.detail).toMatch(/still counts as\s+unsigned/i)
    })
  })

  describe("supersession", () => {
    // Regenerating the agreement mints a new digest and orphans the packet
    // already returned. Live case 2026-08-05: two correct 8-page packets
    // uploaded, agreement regenerated twelve seconds later, both refused
    // with nothing actionable.
    it("flags a packet bound to a superseded AGREEMENT", () => {
      const result = signingPacketLifecycle(
        application({
          returnedPacket: returnedPacket({ boundAgreementSha256: "c".repeat(64) }),
        }),
      )
      expect(result.supersededReturnedPacket).toBe(true)
      expect(result.detail).toMatch(/regenerated since/i)
      expect(result.detail).toMatch(/re-issue the packet/i)
    })

    // Asserted separately from the agreement: a single test moving both digests
    // stays green if either condition is dropped from the check.
    it("flags a packet bound to a superseded PASQ", () => {
      const result = signingPacketLifecycle(
        application({
          returnedPacket: returnedPacket({ boundPasqSha256: "d".repeat(64) }),
        }),
      )
      expect(result.supersededReturnedPacket).toBe(true)
      expect(result.detail).toMatch(/regenerated since/i)
    })

    it("does not flag a packet bound to the current documents", () => {
      const result = signingPacketLifecycle(
        application({ returnedPacket: returnedPacket() }),
      )
      expect(result.supersededReturnedPacket).toBe(false)
      expect(result.detail).not.toMatch(/regenerated since/i)
    })

    it("cannot be superseded when no packet has been returned", () => {
      expect(signingPacketLifecycle(application()).supersededReturnedPacket)
        .toBe(false)
    })
  })

  describe("consumer signed, awaiting countersignature", () => {
    it("offers the returned copy when one exists", () => {
      const result = signingPacketLifecycle(
        application({
          agreementSignedAt: new Date("2026-08-05T11:00:00Z"),
          returnedPacket: returnedPacket({ signatureState: "signed_returned_packet" }),
        }),
      )
      expect(result.state).toBe("signed_awaiting_countersignature")
      expect(result.downloadUrl).toBe("/api/documents/doc_returned/view")
      expect(result.detail).toMatch(/the copy the consumer signed/i)
    })

    // An in-app signature lives on the application until countersignature mints
    // the executed artifact. The packet on offer is the UNSIGNED agreement, and
    // the copy must not imply a signature is drawn on it.
    it("does not imply a visible signature on an in-app signature", () => {
      const result = signingPacketLifecycle(
        application({ agreementSignedAt: new Date("2026-08-05T11:00:00Z") }),
      )
      expect(result.state).toBe("signed_awaiting_countersignature")
      expect(result.downloadUrl).toBe("/api/applications/app_1/signing-packet")
      expect(result.documentId).toBeNull()
      expect(result.detail).toMatch(/shows no signature/i)
      expect(result.unrecordedReturnedPacket).toBe(false)
    })

    // The binding is set at UPLOAD. A signature can then be recorded against a
    // different packet, or captured in-app against no packet at all, leaving an
    // unrecorded upload still bound. Presence of a bound packet is therefore not
    // evidence of signature, and captioning it as "the copy the consumer signed"
    // is a false compliance claim on the surface staff read before disbursing.
    it("refuses to call a still-unrecorded bound packet the signed copy", () => {
      const result = signingPacketLifecycle(
        application({
          agreementSignedAt: new Date("2026-08-05T11:00:00Z"),
          returnedPacket: returnedPacket({
            id: "doc_never_recorded",
            signatureState: "returned_pending_recording",
          }),
        }),
      )
      expect(result.state).toBe("signed_awaiting_countersignature")
      expect(result.unrecordedReturnedPacket).toBe(true)
      expect(result.detail).not.toMatch(/the copy the consumer signed/i)
      expect(result.detail).toMatch(/NOT the copy recorded/i)
    })

    // It must also not be OFFERED: handing staff the unrecorded PDF is the same
    // error as captioning it, one click further on.
    it("does not offer a still-unrecorded bound packet for download", () => {
      const result = signingPacketLifecycle(
        application({
          agreementSignedAt: new Date("2026-08-05T11:00:00Z"),
          returnedPacket: returnedPacket({
            id: "doc_never_recorded",
            signatureState: "returned_pending_recording",
          }),
        }),
      )
      expect(result.downloadUrl).toBe("/api/applications/app_1/signing-packet")
      expect(result.downloadUrl).not.toContain("doc_never_recorded")
      expect(result.documentId).toBeNull()
    })

    // A signatureState this module does not recognise is not evidence either.
    it("treats an unknown signature state as not recorded", () => {
      const result = signingPacketLifecycle(
        application({
          agreementSignedAt: new Date("2026-08-05T11:00:00Z"),
          returnedPacket: returnedPacket({ signatureState: null }),
        }),
      )
      expect(result.unrecordedReturnedPacket).toBe(true)
      expect(result.documentId).toBeNull()
    })
  })

  describe("executed", () => {
    it("supersedes every earlier state", () => {
      const result = signingPacketLifecycle(
        application({
          agreementSignedAt: new Date("2026-08-05T11:00:00Z"),
          agreementCountersignedAt: new Date("2026-08-05T12:00:00Z"),
          agreementExecutedDocumentId: "doc_executed",
          returnedPacket: returnedPacket({ signatureState: "signed_returned_packet" }),
        }),
      )
      expect(result.state).toBe("executed")
      expect(result.downloadUrl).toBe("/api/documents/doc_executed/view")
      expect(result.documentId).toBe("doc_executed")
    })

    // The executed artifact is the one thing to produce on request, so it must
    // win even if the application row is otherwise inconsistent.
    it("wins even with no recorded signature date", () => {
      const result = signingPacketLifecycle(
        application({ agreementExecutedDocumentId: "doc_executed" }),
      )
      expect(result.state).toBe("executed")
      expect(result.downloadUrl).toBe("/api/documents/doc_executed/view")
    })
  })
})
