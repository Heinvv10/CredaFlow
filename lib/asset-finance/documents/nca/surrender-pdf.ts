import { formatDatePdf, formatZarPdf } from "@/lib/pdf/helpers"
import { DealDocumentWriter } from "../pdf-layout"

export interface SurrenderNoticeData {
  reference: string
  documentDate: Date
  lender: { legalName: string; ncrNumber: string; registeredOfficeLines: string[] }
  borrower: { name: string; identityNumber: string; addressLines: string[] }
  asset: { description: string; serialNumber: string; condition: string }
  requestDate: string
  valuationDueDate: string
  valuation?: { valuedOn: string; valuerName: string; amountCents: number }
  outcome?: { saleProceedsCents: number; shortfallCents: number; refundCents: number }
}

export async function renderSurrenderValuationNotice(data: SurrenderNoticeData): Promise<Buffer> {
  const w = await baseWriter(data, "VOLUNTARY SURRENDER VALUATION NOTICE")
  if (!data.valuation) throw new RangeError("Valuation evidence is required")
  w.section("VALUATION")
  w.labelValues([
    ["Valuation date", formatDatePdf(new Date(`${data.valuation.valuedOn}T12:00:00.000Z`))],
    ["Valuer", data.valuation.valuerName],
    ["Valuation", formatZarPdf(data.valuation.amountCents)],
  ])
  w.placeholderClause("1", "Consumer rights following valuation")
  return w.finish({ reference: data.reference, watermark: true })
}

export async function renderSurrenderFinalNotice(data: SurrenderNoticeData): Promise<Buffer> {
  const w = await baseWriter(data, "VOLUNTARY SURRENDER FINAL ACCOUNT NOTICE")
  if (!data.valuation || !data.outcome) throw new RangeError("Valuation and proceeds evidence are required")
  w.section("SALE PROCEEDS AND ACCOUNT RESULT")
  w.labelValues([
    ["Valuation", formatZarPdf(data.valuation.amountCents)],
    ["Sale proceeds credited", formatZarPdf(data.outcome.saleProceedsCents)],
    ["Shortfall", formatZarPdf(data.outcome.shortfallCents)],
    ["Refund due", formatZarPdf(data.outcome.refundCents)],
  ])
  w.placeholderClause("1", "Consumer rights following disposal and account reconciliation")
  return w.finish({ reference: data.reference, watermark: true })
}

async function baseWriter(data: SurrenderNoticeData, title: string): Promise<DealDocumentWriter> {
  const w = await DealDocumentWriter.create({ title: `${title} ${data.reference}`, documentDate: data.documentDate })
  w.letterhead(data.lender.legalName, [`NCR ${data.lender.ncrNumber}`, ...data.lender.registeredOfficeLines])
  w.title(title, [
    `Loan ${data.reference} · prepared ${formatDatePdf(data.documentDate)}`,
    "DRAFT legal wording — statutory wording requires lender legal approval",
  ])
  w.section("CONSUMER AND ASSET")
  w.labelValues([
    ["Consumer", data.borrower.name], ["Identity / registration", data.borrower.identityNumber],
    ["Consumer address", data.borrower.addressLines.join("\n")],
    ["Asset", `${data.asset.description} · ${data.asset.serialNumber}`],
    ["Recorded condition", data.asset.condition], ["Surrender requested", data.requestDate],
    ["Valuation due", data.valuationDueDate],
  ])
  return w
}
