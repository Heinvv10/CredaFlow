import type { DocumentSigner, SignatureState } from "./index"
import { prisma } from "@/lib/prisma"

/**
 * Native (in-app) e-signature adapter — an ordinary electronic signature
 * captured directly in-app, as opposed to a third-party provider (Signum).
 * `requestSignature` marks a `ClientDocument` as awaiting signature;
 * `POST /api/documents/[id]/sign` performs the actual signing (ownership
 * check, IP capture, audit + access log). Native is single-signer, so
 * `signers` is accepted for `DocumentSigner` interface parity but is not
 * persisted here beyond what the sign route itself captures.
 *
 * `ClientDocument` is tenant-scoped (see `TENANT_SCOPED_MODELS` in
 * `lib/tenant-scope.ts`), and the `DocumentSigner` interface carries the
 * caller's `tenantId` as its first arg specifically so these queries stay
 * scoped by it — a `clientDocumentId` supplied by a future "send for
 * signature" caller must never resolve to another tenant's row.
 */
export const nativeSigner: DocumentSigner = {
  async requestSignature(tenantId, clientDocumentId) {
    const doc = await prisma.clientDocument.findFirst({
      where: { id: clientDocumentId, tenantId },
      select: { id: true },
    })
    if (!doc) {
      throw new Error(
        `ClientDocument ${clientDocumentId} not found for tenant ${tenantId}`
      )
    }
    await prisma.clientDocument.update({
      where: { id: clientDocumentId, tenantId },
      data: {
        signatureState: "pending",
        signatureRequestedAt: new Date(),
      },
    })
    return { ref: clientDocumentId, status: "pending" }
  },

  async getStatus(tenantId, ref) {
    const doc = await prisma.clientDocument.findFirst({
      where: { id: ref, tenantId },
      select: { signatureState: true, signedAt: true },
    })
    return {
      state: (doc?.signatureState ?? "none") as SignatureState,
      signedAt: doc?.signedAt ?? null,
    }
  },
}
