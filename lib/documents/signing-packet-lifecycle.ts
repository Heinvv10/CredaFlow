/**
 * ONE signing packet per application, with a lifecycle — not two unsigned
 * halves plus whatever came back sitting among miscellaneous uploads.
 *
 * The client documents folder is document-scoped, but a signing packet is
 * application-scoped: which artifact is authoritative depends entirely on how
 * far the application has travelled. This module answers that question from a
 * LoanApplication row, so the folder can render one card that changes as the
 * consumer and then the credit provider sign, rather than making staff work out which of
 * several similar-looking PDFs is the real one; picking the wrong one costs a round trip on a
 * disbursement.
 *
 * Deliberately a pure function over a row: the states it distinguishes are
 * compliance states, and they need tests that do not depend on a database.
 */

export type SigningPacketState =
  | "not_issued"
  | "awaiting_signature"
  | "returned_pending_recording"
  | "signed_awaiting_countersignature"
  | "executed"

/** What a returned packet says it was issued against, from its own stamp. */
export interface ReturnedPacketBinding {
  id: string
  boundAgreementSha256: string | null
  boundPasqSha256: string | null
  /** "returned_pending_recording" until the signature is recorded. */
  signatureState: string | null
}

export interface SigningPacketLifecycleInput {
  applicationId: string
  reference: string
  agreementGeneratedAt: Date | string | null
  agreementDocumentSha256: string | null
  pasqDocumentSha256: string | null
  agreementSignedAt: Date | string | null
  agreementCountersignedAt: Date | string | null
  agreementExecutedDocumentId: string | null
  returnedPacket: ReturnedPacketBinding | null
}

export interface SigningPacketLifecycle {
  applicationId: string
  reference: string
  state: SigningPacketState
  /** The single artifact worth downloading in this state; null before issue. */
  downloadUrl: string | null
  /** Set when the download is a stored ClientDocument rather than the live packet. */
  documentId: string | null
  headline: string
  detail: string
  /**
   * The returned packet names a PASQ or agreement the application has since
   * replaced, so the signature can no longer be recorded against it.
   */
  supersededReturnedPacket: boolean
  /**
   * A packet is bound to this application but is NOT the one the recorded
   * signature belongs to, so it carries no signature evidence. Set only once a
   * signature exists — before that, "not yet recorded" is the normal state and
   * is reported as `returned_pending_recording` instead.
   */
  unrecordedReturnedPacket: boolean
}

/**
 * The live concatenation endpoint, NOT a stored copy of the issued packet.
 *
 * A stored copy would have to be superseded on every agreement regeneration,
 * and a missed supersession serves a stale-but-official-looking document for
 * signature. This endpoint re-reads the bound PASQ and agreement on every
 * request and re-verifies both digests, so it cannot go stale.
 */
function livePacketUrl(applicationId: string): string {
  return `/api/applications/${applicationId}/signing-packet`
}

function storedDocumentUrl(documentId: string): string {
  return `/api/documents/${documentId}/view`
}

export function signingPacketLifecycle(
  input: SigningPacketLifecycleInput,
): SigningPacketLifecycle {
  const base = {
    applicationId: input.applicationId,
    reference: input.reference,
  }

  // A returned packet is orphaned the moment either bound document is
  // regenerated: regeneration mints a new digest, and the recording step CASes
  // on it. Computed for every state because the answer stays true afterwards —
  // an executed application still shows which packet was superseded on the way.
  const supersededReturnedPacket = input.returnedPacket !== null
    && (
      input.returnedPacket.boundAgreementSha256 !== input.agreementDocumentSha256
      || input.returnedPacket.boundPasqSha256 !== input.pasqDocumentSha256
    )

  if (input.agreementExecutedDocumentId) {
    return {
      ...base,
      state: "executed",
      downloadUrl: storedDocumentUrl(input.agreementExecutedDocumentId),
      documentId: input.agreementExecutedDocumentId,
      headline: "Signed agreement — executed",
      detail:
        "Carries both the consumer's signature and the credit provider's countersignature. "
        + "This is the document to send, print or produce on request.",
      supersededReturnedPacket,
      unrecordedReturnedPacket: false,
    }
  }

  if (!input.agreementGeneratedAt) {
    return {
      ...base,
      state: "not_issued",
      downloadUrl: null,
      documentId: null,
      headline: "Signing packet — not yet prepared",
      detail:
        "Prepare the PASQ and credit agreement on the application. The packet "
        + "then appears here and updates as it is signed.",
      supersededReturnedPacket: false,
      unrecordedReturnedPacket: false,
    }
  }

  if (input.agreementSignedAt) {
    // Countersignature mints the executed artifact. Until it exists there is
    // nothing carrying BOTH signatures, and the copy offered here must not be
    // described as though it does.
    //
    // Only a packet whose OWN signatureState says it was recorded may be called
    // the copy the consumer signed. Presence of a bound packet is NOT enough:
    // the binding is set at upload and the signature can be recorded against a
    // different packet, or captured in-app against no packet at all. Trusting
    // presence alone captions an unsigned upload as signed evidence — a false
    // compliance claim on the one surface staff read before disbursing.
    const recorded = input.returnedPacket?.signatureState === "signed_returned_packet"
      ? input.returnedPacket
      : null
    const unrecordedReturnedPacket = input.returnedPacket !== null && recorded === null
    return {
      ...base,
      state: "signed_awaiting_countersignature",
      // Fall back to the live packet rather than an unrecorded upload: the live
      // packet is the document the recorded signature is digest-bound to.
      downloadUrl: recorded
        ? storedDocumentUrl(recorded.id)
        : livePacketUrl(input.applicationId),
      documentId: recorded?.id ?? null,
      headline: "Signed by the consumer — awaiting credit provider countersignature",
      detail: recorded
        ? "This is the copy the consumer signed and returned. Countersign on the "
          + "application to produce the executed agreement."
        : unrecordedReturnedPacket
          ? "The signature is recorded against this packet's digest. A returned "
            + "upload is also on file that was NOT the copy recorded — it is not "
            + "signature evidence and is not offered here. Check the application's "
            + "audit trail before relying on either."
          : "The consumer's signature is recorded against this packet's digest, but "
            + "it was signed in-app — the packet itself shows no signature until "
            + "countersignature produces the executed agreement.",
      supersededReturnedPacket,
      unrecordedReturnedPacket,
    }
  }

  if (input.returnedPacket) {
    return {
      ...base,
      state: "returned_pending_recording",
      downloadUrl: storedDocumentUrl(input.returnedPacket.id),
      documentId: input.returnedPacket.id,
      headline: "Returned packet uploaded — signature not yet recorded",
      // Deliberately not "signed": every gate downstream reads
      // agreementSignedAt, which is still null. Calling this signed would be a
      // false compliance claim on the one surface staff read before disbursing.
      detail: supersededReturnedPacket
        ? "This packet was returned against an earlier version of the PASQ or "
          + "credit agreement — one of them has been regenerated since. The "
          + "signature can no longer be recorded against it. Re-issue the packet, "
          + "have the consumer sign that copy, and upload it."
        : "Uploaded but not yet recorded, so the application still counts as "
          + "unsigned. Record the signed packet on the application to complete it.",
      supersededReturnedPacket,
      // Not yet recorded is the EXPECTED state here — the state name already
      // says so. This flag is reserved for a packet still bound after a
      // signature was recorded elsewhere.
      unrecordedReturnedPacket: false,
    }
  }

  return {
    ...base,
    state: "awaiting_signature",
    downloadUrl: livePacketUrl(input.applicationId),
    documentId: null,
    headline: "Signing packet — awaiting signature",
    detail:
      "The PASQ and credit agreement as one packet, quotation first. Issue this "
      + "whole document for signature — the two halves cannot be signed apart.",
    supersededReturnedPacket: false,
    unrecordedReturnedPacket: false,
  }
}
