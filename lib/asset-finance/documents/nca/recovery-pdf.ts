import { formatDatePdf, formatZarPdf } from "@/lib/pdf/helpers"
import { DealDocumentWriter, formatIsoDatePdf, type TableColumn } from "../pdf-layout"

export interface RecoveryCostLine {
  label: string
  grossCents: number
  treatment: "DEDUCT_FROM_PROCEEDS" | "CHARGE_TO_ACCOUNT"
}

export interface RecoveryNoticeData {
  reference: string
  documentDate: Date
  lender: { legalName: string; ncrNumber: string; registeredOfficeLines: string[] }
  borrower: { name: string; identityNumber: string; addressLines: string[] }
  asset: { description: string; serialNumber: string; condition: string }
  recoveredOn: string
  location: string
  valuation?: { valuedOn: string; valuerName: string; amountCents: number }
  outcome?: {
    settlementDueCents: number
    grossProceedsCents: number
    deductedCostsCents: number
    chargedCostsCents: number
    netProceedsCents: number
    shortfallCents: number
    surplusCents: number
  }
  costs: RecoveryCostLine[]
}

export const COST_LINES_NOTE = "Cost lines: DRAFT — require lender legal approval"

export const COST_COLUMNS: readonly TableColumn[] = [
  { header: "Cost", x: 44, width: 270 },
  { header: "Treatment", x: 320, width: 130 },
  { header: "Amount", x: 460, width: 90, align: "right" },
]

// UNTESTED: legal sign-off. Titles and layout follow docs/asset-finance/SLICE4.md; the clauses are placeholders.
export async function renderRecoveryValuationNotice(data: RecoveryNoticeData): Promise<Buffer> {
  const w = await baseWriter(data, "REPOSSESSED GOODS VALUATION NOTICE")
  if (!data.valuation) throw new RangeError("Valuation evidence is required")
  w.section("VALUATION")
  w.labelValues([
    ["Valuation date", formatIsoDatePdf(data.valuation.valuedOn)],
    ["Valuer", data.valuation.valuerName],
    ["Valuation", formatZarPdf(data.valuation.amountCents)],
  ])
  w.placeholderClause("1", "Consumer rights following repossession and valuation")
  return w.finish({ reference: data.reference, watermark: true })
}

export async function renderRecoveryFinalNotice(data: RecoveryNoticeData): Promise<Buffer> {
  const w = await baseWriter(data, "REPOSSESSED GOODS FINAL ACCOUNT NOTICE")
  if (!data.valuation || !data.outcome) throw new RangeError("Valuation and proceeds evidence are required")
  const o = data.outcome
  w.section("SALE PROCEEDS AND ACCOUNT RESULT")
  w.labelValues([
    ["Valuation", formatZarPdf(data.valuation.amountCents)],
    ["Settlement due at sale", formatZarPdf(o.settlementDueCents)],
    ["Gross sale proceeds", formatZarPdf(o.grossProceedsCents)],
    ["Costs deducted from proceeds", formatZarPdf(o.deductedCostsCents)],
    ["Net proceeds", formatZarPdf(o.netProceedsCents)],
    ["Costs charged to account", formatZarPdf(o.chargedCostsCents)],
    ["Shortfall", formatZarPdf(o.shortfallCents)],
    ["Surplus due to consumer", formatZarPdf(o.surplusCents)],
  ])
  if (data.costs.length > 0) {
    w.table("RECOVERY COSTS", COST_COLUMNS, data.costs.map((c) => [
      c.label, c.treatment === "DEDUCT_FROM_PROCEEDS" ? "Deducted from proceeds" : "Charged to account", formatZarPdf(c.grossCents),
    ]))
    w.paragraph(COST_LINES_NOTE, w.italic)
  }
  w.placeholderClause("1", "Consumer rights following sale and account reconciliation")
  return w.finish({ reference: data.reference, watermark: true })
}

async function baseWriter(data: RecoveryNoticeData, title: string): Promise<DealDocumentWriter> {
  const w = await DealDocumentWriter.create({ title: `${title} ${data.reference}`, documentDate: data.documentDate })
  w.letterhead(data.lender.legalName, [`NCR ${data.lender.ncrNumber}`, ...data.lender.registeredOfficeLines])
  w.title(title, [
    `Loan ${data.reference} · prepared ${formatDatePdf(data.documentDate)}`,
    "DRAFT legal wording — statutory wording requires lender legal approval",
  ])
  w.section("CONSUMER AND ASSET")
  w.labelValues([
    ["Consumer", data.borrower.name], ["Identity / registration", data.borrower.identityNumber],
    ["Consumer address", data.borrower.addressLines.join(", ")],
    ["Asset", `${data.asset.description} · ${data.asset.serialNumber}`],
    ["Recorded condition", data.asset.condition], ["Repossessed on", formatIsoDatePdf(data.recoveredOn)],
    ["Held at", data.location],
  ])
  return w
}
