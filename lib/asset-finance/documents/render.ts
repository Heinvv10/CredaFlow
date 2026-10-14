// One entry point for rendering a deal document for a signer row.
import type { DealDocumentKind } from "@prisma/client"
import { sha256DocumentBytes } from "@/lib/documents/content-integrity"
import type { DealDocumentData } from "./deal-document-data"
import { renderInstalmentSaleAgreement } from "./agreement-pdf"
import { renderResolution } from "./resolution-pdf"
import { renderSuretyship } from "./suretyship-pdf"

export interface RenderedDealDocument {
  bytes: Buffer
  sha256: string
}

/** The agreement and the resolution are one document each; a suretyship is the surety's own. */
export async function renderDealDocument(
  data: DealDocumentData,
  document: DealDocumentKind,
  clientId: string,
): Promise<RenderedDealDocument> {
  const bytes =
    document === "AGREEMENT" ? await renderInstalmentSaleAgreement(data)
    : document === "RESOLUTION" ? await renderResolution(data)
    : await renderSuretyship(data, clientId)
  return { bytes, sha256: sha256DocumentBytes(bytes) }
}

export function dealDocumentFileName(reference: string, document: DealDocumentKind, signerName: string): string {
  const base = document === "AGREEMENT" ? "instalment-sale-agreement" : document === "RESOLUTION" ? "resolution" : "suretyship"
  const who = document === "SURETYSHIP" ? `-${signerName}` : ""
  return `${base}-${reference}${who}.pdf`.replace(/[^A-Za-z0-9._-]+/g, "-")
}
