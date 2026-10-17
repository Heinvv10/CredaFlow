// The terms and conditions of the operating-lease and full-maintenance-lease
// agreements (section 9 of ../lease/agreement-pdf.ts), drafted for the lender's
// legal team to review: the DRAFT watermark stays until
// TenantConfig.assetFinanceLegalWordingApproved. Clauses print as 9.1, 9.2, …
// in this order; the cross-references in the text depend on it.
// docs/asset-finance/legal-wording/lease.md lists the sources and the points
// for legal. No NCA content: a lease is not a credit agreement.
//
// Two variants. Where the CPA applies (LeaseDocumentTerms.cpaApplies) the
// clauses give the lessee its s14 rights, draw attention to the risk and
// indemnity terms (s49) and leave out the commercial-only terms (renunciation,
// certificate as proof, consent to jurisdiction, own-client costs). Otherwise
// they are normal commercial terms.
import type { LeaseTerms } from "../../lease-input"
import type { DealDocumentData } from "../deal-document-data"
import { goodsClauses } from "./lease-agreement-goods"
import { endClauses } from "./lease-agreement-end"
import { maintenanceClauses } from "./lease-maintenance"

export interface WordingClause {
  heading: string
  text: string
}

export interface LeaseWordingInput {
  lessorName: string
  lesseeName: string
  fml: boolean
  cpa: boolean
  terms: LeaseTerms
  pricing: Pick<DealDocumentData["pricing"], "rateBasis" | "arrearsMarginRate" | "collectionFeeCents">
  /** The commencement date and the last day of the term, printed. */
  startDate: string
  endDate: string
}

export function leaseAgreementClauses(input: LeaseWordingInput): WordingClause[] {
  return [...goodsClauses(input), ...endClauses(input), ...(input.fml ? maintenanceClauses(input) : [])]
}
