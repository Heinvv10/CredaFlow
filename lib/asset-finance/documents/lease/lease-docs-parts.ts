// Pieces the three lease servicing documents share (slice 3, C9): the opening
// (letterhead, title, lease particulars), the lender's contacts and the
// document date. Every document is a draft until the lender's legal team has
// approved the wording (the DRAFT watermark, as ./agreement-pdf.ts).
import { DealDocumentWriter } from "../pdf-layout"
import type { LeaseDocBase, LeaseDocLender } from "./lease-docs-types"

/** The PDF creation and modification date: the document's own day, so the same data renders the same bytes. */
export const documentDateOf = (iso: string): Date => new Date(`${iso}T12:00:00.000Z`)

export async function openLeaseDocument(
  lender: LeaseDocLender,
  base: LeaseDocBase,
  doc: { title: string; subtitle: string; dateIso: string },
): Promise<DealDocumentWriter> {
  const w = await DealDocumentWriter.create({ title: `${doc.title} ${base.reference}`, documentDate: documentDateOf(doc.dateIso) })
  w.letterhead(lender.legalName, [lender.registeredOfficeLines.join(", ")])
  w.title(doc.title.toUpperCase(), [doc.subtitle])
  return w
}

export function leaseRows(base: LeaseDocBase): [string, string][] {
  return [["Lessee", base.lessee], ["Lease reference", base.reference], ["Goods", base.asset]]
}

export function contactRows(lender: LeaseDocLender): [string, string][] {
  return [
    ["Lessor", lender.tradingName === lender.legalName ? lender.legalName : `${lender.legalName} (trading as ${lender.tradingName})`],
    ["Email", lender.publicEmail],
    ["Telephone", lender.publicPhone],
    ["Collections email", lender.collectionsEmail],
    ["Collections telephone", lender.collectionsPhone],
  ]
}

export function finishLeaseDocument(w: DealDocumentWriter, base: LeaseDocBase): Promise<Buffer> {
  return w.finish({ reference: base.reference, watermark: base.draft })
}
