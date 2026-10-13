// The entity's resolution to enter into the deal (goal §4.9): a board
// resolution for a company, a trustees' resolution for a trust (members for
// a CC, partners for a partnership). It names the deal and the people
// authorised to sign; the resolution text itself is a marked placeholder
// until the lender's legal team supplies it, with the DRAFT watermark.
import type { BusinessEntityType } from "@prisma/client"
import { formatDatePdf } from "@/lib/pdf/helpers"
import type { DealDocumentData } from "./deal-document-data"
import { DealDocumentWriter } from "./pdf-layout"
import { debtSummary, entityRows, lenderLetterhead } from "./document-parts"

const BODY: Record<BusinessEntityType, { title: string; signedAs: string }> = {
  COMPANY: { title: "RESOLUTION OF THE BOARD OF DIRECTORS", signedAs: "Director / authorised signatory" },
  TRUST: { title: "RESOLUTION OF THE TRUSTEES", signedAs: "Trustee / authorised signatory" },
  CC: { title: "RESOLUTION OF THE MEMBERS", signedAs: "Member / authorised signatory" },
  PARTNERSHIP: { title: "RESOLUTION OF THE PARTNERS", signedAs: "Partner / authorised signatory" },
}

const CLAUSES = [
  "Approval of the transaction",
  "Authority to sign",
  "Ratification",
]

export async function renderResolution(data: DealDocumentData): Promise<Buffer> {
  const body = BODY[data.entity.type]
  const w = await DealDocumentWriter.create({ title: `Resolution ${data.reference}`, documentDate: data.documentDate })
  lenderLetterhead(w, data)
  w.title(body.title, [
    `${data.entity.legalName} · agreement reference ${data.reference} · prepared ${formatDatePdf(data.documentDate)}`,
  ])

  w.section("1. THE ENTITY")
  w.labelValues(entityRows(data))
  w.section("2. THE TRANSACTION")
  w.labelValues([["Credit provider", data.lender.legalName], ...debtSummary(data)])
  w.section("3. PERSONS AUTHORISED TO SIGN")
  w.labelValues(data.signatories.map((s, i) => [`${i + 1}.`, s.name]))

  w.section("4. RESOLUTIONS")
  CLAUSES.forEach((heading, i) => w.placeholderClause(`4.${i + 1}`, heading))

  w.section("5. SIGNATURES")
  w.signatures(data.signatories.map((s) => ({ caption: data.entity.legalName, name: s.name, detail: body.signedAs })))
  return w.finish({ reference: data.reference, watermark: !data.legalWordingApproved })
}
