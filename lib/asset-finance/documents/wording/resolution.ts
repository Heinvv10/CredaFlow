// The entity resolution's clauses (./../resolution-pdf.ts section 4), worded
// for the entity type. DRAFT wording for the lender's legal team (the rules
// behind it are signed off: see DESIGN.md sign-off record 2026-10-17); the DRAFT
// watermark prints until TenantConfig.assetFinanceLegalWordingApproved. The
// same text serves NCA and non-NCA deals: it grants authority and binds no
// consumer to any term of the Agreement.
// Notes and sources: docs/asset-finance/legal-wording/commercial.md.
import type { BusinessEntityType } from "@prisma/client"
import type { DealDocumentData } from "../deal-document-data"
import type { WordingClause } from "./commercial-common"

interface EntityWording {
  /** "Company": the defined term, used as "the Company" */
  noun: string
  /** Who passes the resolution, and how. */
  body: (data: DealDocumentData) => string
  /** The constitutive document the transaction must be within. */
  constitution: string
}

const ENTITY: Record<BusinessEntityType, EntityWording> = {
  COMPANY: {
    noun: "Company",
    body: () => "the board of directors of the Company, at a properly convened meeting or by written consent under section 74 of the Companies Act 71 of 2008",
    constitution: "its Memorandum of Incorporation",
  },
  CC: {
    noun: "Corporation",
    body: () => "the members of the Corporation, in accordance with its association agreement (if any) and the Close Corporations Act 69 of 1984",
    constitution: "its founding statement and association agreement (if any)",
  },
  TRUST: {
    noun: "Trust",
    body: (data) => `the trustees of the Trust, acting jointly as its trust deed requires, each holding letters of authority issued by the Master of the High Court under section 6 of the Trust Property Control Act 57 of 1988${data.entity.mastersReference ? ` (Master's reference ${data.entity.mastersReference})` : ""}`,
    constitution: "its trust deed",
  },
  PARTNERSHIP: {
    noun: "Partnership",
    body: () => "the partners of the Partnership, in accordance with its partnership agreement",
    constitution: "its partnership agreement",
  },
}

function persons(data: DealDocumentData): string {
  return data.signatories.length === 1 ? "the person named in section 3" : "the persons named in section 3, acting together,"
}

/** Clauses 4.1 to 4.3 in printed order. */
export function resolutionClauses(data: DealDocumentData): WordingClause[] {
  const e = ENTITY[data.entity.type]
  const short = `the ${e.noun}`
  return [
    {
      heading: "Approval of the transaction",
      text: `This resolution is passed by ${e.body(data)}. ${data.entity.legalName} (the "${e.noun}") is described in section 1.

RESOLVED that ${short} enter into the agreement with ${data.lender.legalName} ("the Creditor") with the agreement reference ${data.reference} ("the Agreement"), for the finance of the goods and on the terms summarised in section 2, and into every document the Creditor reasonably requires to give effect to it, including a debit order mandate, a delivery and acceptance certificate and insurance documents.

The undersigned record that they have considered the terms of the Agreement, that entering into it is in the interests of ${short}, and that it is within the powers of ${short} under ${e.constitution}.`,
    },
    {
      heading: "Authority to sign",
      text: `RESOLVED that ${persons(data)} ${data.signatories.length === 1 ? "is" : "are"} authorised to sign the Agreement and the documents referred to in clause 4.1 on behalf of ${short} and to do everything necessary to give effect to them.`,
    },
    {
      heading: "Ratification",
      text: `RESOLVED that everything already done by any person named in section 3 on behalf of ${short} in connection with the Agreement is ratified and confirmed.

The undersigned confirm that this resolution was passed in accordance with ${e.constitution} and the law that governs ${short}, and that it has not been amended or revoked. The Creditor may rely on it until it receives written notice that it has been revoked; a revocation does not affect any document already signed under it.`,
    },
  ]
}
