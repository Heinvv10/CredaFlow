import { formatDatePdf, formatZarPdf } from "@/lib/pdf/helpers"
import { DealDocumentWriter, type TableColumn } from "../pdf-layout"
import { surrenderFinalClause, surrenderValuationClause } from "../wording/nca-surrender"

export interface SurrenderNoticeData {
  /** TenantConfig.assetFinanceLegalWordingApproved; false prints the DRAFT watermark, subtitle and line notes. */
  legalWordingApproved: boolean
  reference: string
  documentDate: Date
  lender: { legalName: string; ncrNumber: string; registeredOfficeLines: string[] }
  borrower: { name: string; identityNumber: string; addressLines: string[] }
  asset: { description: string; serialNumber: string; condition: string }
  requestDate: string
  valuationDueDate: string
  valuation?: { valuedOn: string; valuerName: string; amountCents: number }
  outcome?: { saleProceedsCents: number; shortfallCents: number; refundCents: number }
  /** The linked recovery's sale and account figures; their lines are added after the existing ones only when this is present. */
  recoveryOutcome?: {
    settlementDueCents: number; grossProceedsCents: number; deductedCostsCents: number; netProceedsCents: number
    chargedCostsCents: number; shortfallCents: number; surplusCents: number; unrecoverableCostsCents?: number
  }
  /** The linked recovery's costs; a "RECOVERY COSTS" section is printed only when this is non-empty. */
  costs?: { type: string; label: string; grossCents: number; treatment: "DEDUCT_FROM_PROCEEDS" | "CHARGE_TO_ACCOUNT" }[]
}

const COST_COLUMNS: readonly TableColumn[] = [
  { header: "Cost", x: 44, width: 270 },
  { header: "Treatment", x: 320, width: 130 },
  { header: "Amount", x: 460, width: 90, align: "right" },
]

export async function renderSurrenderValuationNotice(data: SurrenderNoticeData): Promise<Buffer> {
  const w = await baseWriter(data, "VOLUNTARY SURRENDER VALUATION NOTICE")
  if (!data.valuation) throw new RangeError("Valuation evidence is required")
  w.section("VALUATION")
  w.labelValues([
    ["Valuation date", formatDatePdf(new Date(`${data.valuation.valuedOn}T12:00:00.000Z`))],
    ["Valuer", data.valuation.valuerName],
    ["Valuation", formatZarPdf(data.valuation.amountCents)],
  ])
  const clause = surrenderValuationClause(data)
  w.clause("1", clause.heading, clause.text)
  return w.finish({ reference: data.reference, watermark: !data.legalWordingApproved })
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
  if (data.recoveryOutcome) recoveryOutcomeLines(w, data.recoveryOutcome, data.legalWordingApproved)
  if (data.costs && data.costs.length > 0) recoveryCosts(w, data.costs, data.legalWordingApproved)
  const clause = surrenderFinalClause(data)
  w.clause("1", clause.heading, clause.text)
  return w.finish({ reference: data.reference, watermark: !data.legalWordingApproved })
}

// The recovery's sale and account lines: signed off by the lender's legal team, 2026-10-17.
function recoveryOutcomeLines(w: DealDocumentWriter, o: NonNullable<SurrenderNoticeData["recoveryOutcome"]>, approved: boolean): void {
  w.labelValues([
    ["Settlement due at sale", formatZarPdf(o.settlementDueCents)],
    ["Gross sale price", formatZarPdf(o.grossProceedsCents)],
    ["Costs deducted from proceeds", formatZarPdf(o.deductedCostsCents)],
    ["Net proceeds", formatZarPdf(o.netProceedsCents)],
    ["Costs charged to account", formatZarPdf(o.chargedCostsCents)],
    ...(o.unrecoverableCostsCents ? [["Charged costs not recoverable on the account", formatZarPdf(o.unrecoverableCostsCents)] as [string, string]] : []),
    ["Account shortfall", formatZarPdf(o.shortfallCents - (o.unrecoverableCostsCents ?? 0))],
    ["Account surplus", formatZarPdf(o.surplusCents)],
  ])
  if (!approved) w.paragraph("Sale and account lines: DRAFT — require lender legal approval", w.italic)
}

// Which costs an NCA lender may show against the account: signed off by the lender's legal team, 2026-10-17.
function recoveryCosts(w: DealDocumentWriter, costs: NonNullable<SurrenderNoticeData["costs"]>, approved: boolean): void {
  w.table("RECOVERY COSTS", COST_COLUMNS, costs.map((c) => [
    c.label, c.treatment === "DEDUCT_FROM_PROCEEDS" ? "Deducted from proceeds" : "Charged to account", formatZarPdf(c.grossCents),
  ]))
  const sum = (treatment: "DEDUCT_FROM_PROCEEDS" | "CHARGE_TO_ACCOUNT") => costs.filter((c) => c.treatment === treatment).reduce((n, c) => n + c.grossCents, 0)
  w.labelValues([
    ["Costs deducted from proceeds", formatZarPdf(sum("DEDUCT_FROM_PROCEEDS"))],
    ["Costs charged to account", formatZarPdf(sum("CHARGE_TO_ACCOUNT"))],
  ])
  if (!approved) w.paragraph("Cost lines: DRAFT — require lender legal approval", w.italic)
}

async function baseWriter(data: SurrenderNoticeData, title: string): Promise<DealDocumentWriter> {
  const w = await DealDocumentWriter.create({ title: `${title} ${data.reference}`, documentDate: data.documentDate })
  w.letterhead(data.lender.legalName, [`NCR ${data.lender.ncrNumber}`, ...data.lender.registeredOfficeLines])
  w.title(title, [
    `Loan ${data.reference} · prepared ${formatDatePdf(data.documentDate)}`,
    ...(data.legalWordingApproved ? [] : ["DRAFT legal wording — statutory wording requires lender legal approval"]),
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
