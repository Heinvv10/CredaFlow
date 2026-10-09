import type { DocumentSigner } from "./index"

/**
 * Minimal stub gated behind DOCUMENT_SIGNUM_ENABLED — full Signum (owned
 * e-sign) integration ships in Task 17.
 */
export const signumSigner: DocumentSigner = {
  requestSignature(_tenantId, _clientDocumentId, _signers) {
    return Promise.reject(signumDisabledError())
  },
  getStatus(_tenantId, _ref) {
    return Promise.reject(signumDisabledError())
  },
}

function signumDisabledError(): Error {
  if (process.env.DOCUMENT_SIGNUM_ENABLED === "true") {
    return new Error("Signum signing is not yet implemented")
  }
  return new Error("Signum signing is not enabled (DOCUMENT_SIGNUM_ENABLED)")
}
