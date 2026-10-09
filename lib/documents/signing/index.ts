import type { DocumentSigningMethod } from "@prisma/client"
import { nativeSigner } from "./native"
import { signumSigner } from "./signum"

export type SignatureState = "none" | "pending" | "signed" | "declined"

export interface Signer {
  name: string
  email?: string | null
  role?: string | null
}

export interface SignatureRequest {
  ref: string
  status: SignatureState
}

export interface SignatureStatus {
  state: SignatureState
  signedAt?: Date | null
}

/**
 * Pluggable e-signature abstraction (mirrors the collection-engine provider
 * pattern) — a `DocumentTemplate.signingMethod` selects one implementation
 * without the caller (generation/document-workflow code) knowing which.
 */
export interface DocumentSigner {
  requestSignature(
    tenantId: string,
    clientDocumentId: string,
    signers: Signer[]
  ): Promise<SignatureRequest>
  getStatus(tenantId: string, ref: string): Promise<SignatureStatus>
}

const noneSigner: DocumentSigner = {
  requestSignature() {
    return Promise.reject(new Error("signing not enabled for this document"))
  },
  getStatus() {
    return Promise.resolve({ state: "none" })
  },
}

/** Resolves the `DocumentSigner` implementation for a template's `signingMethod`. */
export function getSigner(method: DocumentSigningMethod): DocumentSigner {
  switch (method) {
    case "NATIVE":
      return nativeSigner
    case "SIGNUM":
      return signumSigner
    case "NONE":
    default:
      return noneSigner
  }
}
