// One entry point for rendering a deal document for a signer row.
import type { DealDocumentKind } from "@prisma/client"
import { sha256DocumentBytes } from "@/lib/documents/content-integrity"
import { DealDocumentError, type AnyDealDocumentData, type DealDocumentData } from "./deal-document-data"
import { renderInstalmentSaleAgreement } from "./agreement-pdf"
import { renderResolution } from "./resolution-pdf"
import { renderSuretyship } from "./suretyship-pdf"
import { renderLeaseAgreement } from "./lease/agreement-pdf"

export interface RenderedDealDocument {
  bytes: Buffer
  sha256: string
}

/** An entity's deal data: the instalment-sale agreement, the resolution and suretyships need it. */
function entityData(data: AnyDealDocumentData): DealDocumentData {
  if (data.entity === null) throw new DealDocumentError("A sole proprietor's lease has only its agreement")
  return data
}

/**
 * The agreement and the resolution are one document each; a suretyship is the
 * surety's own. A lease's agreement is the lease agreement (./lease/agreement-pdf.ts).
 */
export async function renderDealDocument(
  data: AnyDealDocumentData,
  document: DealDocumentKind,
  clientId: string,
): Promise<RenderedDealDocument> {
  const bytes =
    document === "AGREEMENT" ? await (data.lease ? renderLeaseAgreement(data) : renderInstalmentSaleAgreement(entityData(data)))
    : document === "RESOLUTION" ? await renderResolution(entityData(data))
    : await renderSuretyship(entityData(data), clientId)
  return { bytes, sha256: sha256DocumentBytes(bytes) }
}

const AGREEMENT_FILE: Partial<Record<string, string>> = {
  OPERATING_LEASE: "operating-lease-agreement",
  FULL_MAINTENANCE_LEASE: "full-maintenance-lease-agreement",
}

export function dealDocumentFileName(reference: string, document: DealDocumentKind, signerName: string, contractType?: string): string {
  const agreement = (contractType && AGREEMENT_FILE[contractType]) || "instalment-sale-agreement"
  const base = document === "AGREEMENT" ? agreement : document === "RESOLUTION" ? "resolution" : "suretyship"
  const who = document === "SURETYSHIP" ? `-${signerName}` : ""
  return `${base}-${reference}${who}.pdf`.replace(/[^A-Za-z0-9._-]+/g, "-")
}
