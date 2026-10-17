// A suretyship for one surety of a deal (goal §4.9): one document per surety,
// signed by that surety alone. The parties and the debt are real data; the
// clauses are drafted wording (./wording/suretyship.ts) awaiting the lender's
// legal team, and the DRAFT watermark prints until it is approved.
import { formatDatePdf } from "@/lib/pdf/helpers"
import type { DealDocumentData, DocumentPerson } from "./deal-document-data"
import { DealDocumentError } from "./deal-document-data"
import { DealDocumentWriter } from "./pdf-layout"
import { suretyshipClauses } from "./wording/suretyship"
import { debtSummary, entityRows, lenderLetterhead, lenderRows } from "./document-parts"

export function suretyFor(data: DealDocumentData, clientId: string): DocumentPerson {
  const surety = data.sureties.find((s) => s.clientId === clientId)
  if (!surety) throw new DealDocumentError("This person is not an active surety of the deal's entity")
  return surety
}

export async function renderSuretyship(data: DealDocumentData, suretyClientId: string): Promise<Buffer> {
  const surety = suretyFor(data, suretyClientId)
  const w = await DealDocumentWriter.create({ title: `Suretyship ${data.reference} ${surety.name}`, documentDate: data.documentDate })
  lenderLetterhead(w, data)
  w.title("DEED OF SURETYSHIP", [
    `Agreement reference ${data.reference} · prepared ${formatDatePdf(data.documentDate)}`,
  ])

  w.section("1. THE SURETY")
  w.labelValues([
    ["Name", surety.name],
    ["Identity number", surety.idNumber],
  ])
  w.section("2. THE CREDITOR")
  w.labelValues(lenderRows(data))
  w.section("3. THE PRINCIPAL DEBTOR")
  w.labelValues(entityRows(data))
  w.section("4. THE DEBT")
  w.labelValues(debtSummary(data))

  w.section("5. TERMS AND CONDITIONS")
  suretyshipClauses(data, surety).forEach((c, i) => w.clause(`5.${i + 1}`, c.heading, c.text))

  w.section("6. SIGNATURES")
  w.signatures([
    { caption: "The surety", name: surety.name, detail: `Identity number ${surety.idNumber}` },
    { caption: "Spouse of the surety (only if married in community of property)", name: "Name:", detail: "Consents under section 15(2)(h) of the Matrimonial Property Act 88 of 1984" },
    { caption: "Witness", name: "Name:" },
  ])
  return w.finish({ reference: data.reference, watermark: !data.legalWordingApproved })
}
