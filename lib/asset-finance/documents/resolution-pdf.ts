// The entity's resolution to enter into the deal (goal §4.9): a board
// resolution for a company, a trustees' resolution for a trust (members for
// a CC, partners for a partnership). It names the deal and the people
// authorised to sign; the resolution text (./wording/resolution.ts) is
// drafted wording awaiting the lender's legal team. Issued, the lender's
// approved template version adds its terms after 4.3 and sets the watermark.
import type { BusinessEntityType } from "@prisma/client"
import { formatDatePdf } from "@/lib/pdf/helpers"
import type { DealDocumentData } from "./deal-document-data"
import { DealDocumentWriter } from "./pdf-layout"
import { resolutionClauses } from "./wording/resolution"
import { debtSummary, entityRows, lenderLetterhead } from "./document-parts"
import { additionalTerms, identityTokens, wordingWatermark, type AppliedWording } from "./templates/apply"

const BODY: Record<BusinessEntityType, { title: string; signedAs: string }> = {
  COMPANY: { title: "RESOLUTION OF THE BOARD OF DIRECTORS", signedAs: "Director / authorised signatory" },
  TRUST: { title: "RESOLUTION OF THE TRUSTEES", signedAs: "Trustee / authorised signatory" },
  CC: { title: "RESOLUTION OF THE MEMBERS", signedAs: "Member / authorised signatory" },
  PARTNERSHIP: { title: "RESOLUTION OF THE PARTNERS", signedAs: "Partner / authorised signatory" },
}

export async function renderResolution(data: DealDocumentData, wording?: AppliedWording): Promise<Buffer> {
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
  const clauses = resolutionClauses(data)
  clauses.forEach((c, i) => w.clause(`4.${i + 1}`, c.heading, c.text))
  additionalTerms(wording, identityTokens(data.lender, data.reference)).forEach((c, i) => w.clause(`4.${clauses.length + i + 1}`, c.heading, c.text))

  w.section("5. SIGNATURES")
  w.signatures(data.signatories.map((s) => ({ caption: data.entity.legalName, name: s.name, detail: body.signedAs })))
  return w.finish({ reference: data.reference, watermark: !data.legalWordingApproved, mark: wordingWatermark(wording, data.legalWordingApproved) })
}
