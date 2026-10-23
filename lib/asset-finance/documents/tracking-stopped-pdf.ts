import { formatDatePdf } from "@/lib/pdf/helpers"
import { DealDocumentWriter } from "./pdf-layout"
import { TRACKING_STOPPED_TITLE, trackingStoppedParagraphs, type TrackingStoppedFacts } from "./wording/tracking-stopped"

export interface TrackingStoppedLetterData extends TrackingStoppedFacts {
  documentDate: Date
  lender: { legalName: string; ncrNumber: string; registeredOfficeLines: string[] }
  recipient: { name: string; addressLines: string[] }
  /** TenantConfig.assetFinanceLegalWordingApproved; false prints the DRAFT watermark. */
  legalWordingApproved: boolean
}

/** The stored "tracking stopped" letter (lib/asset-finance/tracker-closure.ts): the notice's words on the lender's letterhead. */
export async function renderTrackingStoppedLetter(data: TrackingStoppedLetterData): Promise<Buffer> {
  const w = await DealDocumentWriter.create({ title: `${TRACKING_STOPPED_TITLE} ${data.loanReference}`, documentDate: data.documentDate })
  w.letterhead(data.lender.legalName, [`NCR ${data.lender.ncrNumber}`, ...data.lender.registeredOfficeLines])
  w.title(TRACKING_STOPPED_TITLE.toUpperCase(), [
    `Agreement ${data.loanReference} · ${formatDatePdf(data.documentDate)}`,
    ...(data.legalWordingApproved ? [] : ["DRAFT wording — requires lender legal approval"]),
  ])
  w.labelValues([["To", data.recipient.name], ["Address", data.recipient.addressLines.join(", ") || "—"], ["Asset", data.assetDescription]])
  w.gap(8)
  for (const paragraph of trackingStoppedParagraphs(data)) w.paragraph(paragraph)
  return w.finish({ reference: data.loanReference, watermark: !data.legalWordingApproved })
}
