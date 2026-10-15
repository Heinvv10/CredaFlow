// A portal client e-signs their own deal document (goal §4.9, decision 2a.5),
// as the consumer flow signs a credit agreement
// (app/api/applications/[id]/agreement/sign): the signer echoes the digest of
// the bytes they were shown, the stored bytes must still hash to the bound
// digest, and a fresh render must hash the same (the deal has not changed
// since it was prepared). The drawn PNG data URL or typed name is stored with
// its sha256, the IP and the instant, and the signature is audited.
//
// The signer row is found by its id AND the session client: anyone else's
// row — another surety's suretyship, the agreement for a surety-only client —
// is "not found".
import { createHash } from "node:crypto"
import { prisma } from "@/lib/prisma"
import { readFile } from "@/lib/storage"
import { documentBytesMatchSha256, isSha256Digest } from "@/lib/documents/content-integrity"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { recordedCallerIp } from "@/lib/rate-limit"
import { loadDealDocumentData } from "./documents/deal-document-data"
import { renderDealDocument } from "./documents/render"
import { portalSignerWhere } from "./portal-access"

const MAX_SIGNATURE_LENGTH = 500_000
const PNG_PREFIX = "data:image/png;base64,"
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function isPngDataUrl(value: string): boolean {
  const encoded = value.slice(PNG_PREFIX.length)
  if (encoded.length < 100 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return false
  const bytes = Buffer.from(encoded, "base64")
  return bytes.length >= 75 && bytes.subarray(0, 8).equals(PNG_MAGIC)
}

export type SignatureInput = { signature: string; documentSha256: string } | { error: string; status: 400 | 413 | 422 }

/** `{ signature, documentSha256 }`: a drawn PNG data URL or a typed name (3–120 characters). */
export function parseSignatureInput(body: unknown): SignatureInput {
  const record = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {}
  const { signature, documentSha256 } = record
  if (typeof signature === "string" && signature.length > MAX_SIGNATURE_LENGTH) {
    return { error: "Signature artefact is too large", status: 413 }
  }
  if (!isSha256Digest(documentSha256)) return { error: "documentSha256 must be the digest of the document you were shown", status: 400 }
  const value = typeof signature === "string" ? signature.trim() : ""
  if (value.startsWith("data:")) {
    if (!value.startsWith(PNG_PREFIX) || !isPngDataUrl(value)) return { error: "A drawn signature must be a PNG image", status: 422 }
    return { signature: value, documentSha256 }
  }
  if (value.length < 3 || value.length > 120 || /[\u0000-\u001f\u007f]/.test(value)) {
    return { error: "Draw your signature or type your full name", status: 422 }
  }
  return { signature: value, documentSha256 }
}

export type ESignResult =
  | { kind: "not_found" }
  | { kind: "not_signable"; reason: string }
  | { kind: "stale_view" }
  | { kind: "document_changed" }
  | { kind: "signed"; signedAt: Date }

export async function recordESignature(params: {
  tenantId: string
  clientId: string
  clientEmail: string | null
  signerId: string
  input: { signature: string; documentSha256: string }
  ip: string | null
}): Promise<ESignResult> {
  const { tenantId, clientId, signerId, input } = params
  const signer = await prisma.dealSigner.findFirst({
    where: { id: signerId, tenantId, clientId, AND: [portalSignerWhere(tenantId, clientId)] },
    select: {
      id: true, dealId: true, clientId: true, document: true, method: true,
      documentSha256: true, documentStoragePath: true, deal: { select: {
        status: true, entityId: true, application: { select: { ncaRegime: true } },
      } },
    },
  })
  if (!signer || !signer.documentSha256 || !signer.documentStoragePath) return { kind: "not_found" }
  if (signer.method !== null) return { kind: "not_signable", reason: "This document has already been signed" }
  if (signer.deal.status !== "APPROVED") return { kind: "not_signable", reason: "This deal is not open for signing" }
  if (input.documentSha256 !== signer.documentSha256) return { kind: "stale_view" }

  const stored = await readFile(signer.documentStoragePath).catch(() => null)
  if (!stored || !documentBytesMatchSha256(stored, signer.documentSha256)) return { kind: "document_changed" }
  const entityNca = signer.deal.entityId !== null && signer.deal.application.ncaRegime === "NCA"
  if (!entityNca) {
    const data = await loadDealDocumentData(prisma, tenantId, signer.dealId)
    if (!data) return { kind: "not_found" }
    const stillRequired = data.requiredSigners.some((s) => s.clientId === clientId && s.document === signer.document)
    if (!stillRequired) return { kind: "not_signable", reason: "You are no longer required to sign this document; the lender will prepare the documents again" }
    const fresh = await renderDealDocument(data, signer.document, clientId)
    if (fresh.sha256 !== signer.documentSha256) return { kind: "document_changed" }
  }

  const signedAt = new Date()
  // The database recomputes this digest (CHECK DealSigner_method_evidence).
  const signatureSha256 = createHash("sha256").update(input.signature, "utf8").digest("hex")
  const signed = await prisma.$transaction(async (tx) => {
    const { count } = await tx.dealSigner.updateMany({
      where: { id: signer.id, tenantId, clientId, method: null, documentSha256: signer.documentSha256 },
      data: { method: "E_SIGN", signedAt, signatureData: input.signature, signatureSha256, signedByIp: params.ip },
    })
    if (count !== 1) return false
    await logAuditStrict(
      {
        tenantId,
        userEmail: params.clientEmail ?? undefined,
        action: AuditAction.ASSET_DEAL_DOCUMENT_SIGNED,
        entity: "DealSigner",
        entityId: signer.id,
        newValue: {
          dealId: signer.dealId,
          clientId,
          document: signer.document,
          method: "E_SIGN",
          documentSha256: signer.documentSha256,
          signatureSha256,
          signatureKind: input.signature.startsWith(PNG_PREFIX) ? "drawn" : "typed",
          signedAt: signedAt.toISOString(),
        },
        ipAddress: params.ip ?? undefined,
      },
      tx,
    )
    return true
  })
  return signed ? { kind: "signed", signedAt } : { kind: "not_signable", reason: "This document was signed or changed while you were signing" }
}

/**
 * The signer's IP for the evidence row, by the trusted-proxy rule
 * TRUSTED_PROXY): X-Forwarded-For entries a client prepends are never read.
 * Null when no trusted proxy vouches for an address ("unknown" is a rate-limit
 * bucket, not an IP).
 */
export function requestIp(req: Request): string | null {
  return recordedCallerIp(req)
}
