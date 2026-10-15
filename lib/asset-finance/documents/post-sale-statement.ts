import { formatDatePdf, formatZarPdf } from "@/lib/pdf/helpers"
import { DealDocumentWriter } from "./pdf-layout"
import { COST_COLUMNS, type RecoveryNoticeData } from "./nca/recovery-pdf"

/**
 * The account statement of a NON_NCA recovery after its sale. A plain
 * statement of figures, not a National Credit Act notice (a NON_NCA contract
 * has none), so it lives outside documents/nca and carries no clause text.
 */
export async function renderPostSaleStatement(data: RecoveryNoticeData): Promise<Buffer> {
  const o = data.outcome
  if (!o) throw new RangeError("The sale proceeds must be applied before the statement")
  const title = "POST-SALE ACCOUNT STATEMENT"
  const w = await DealDocumentWriter.create({ title: `${title} ${data.reference}`, documentDate: data.documentDate })
  w.letterhead(data.lender.legalName, data.lender.registeredOfficeLines)
  w.title(title, [`Contract ${data.reference} · prepared ${formatDatePdf(data.documentDate)}`])
  w.section("CUSTOMER AND ASSET")
  w.labelValues([
    ["Customer", data.borrower.name], ["Registration number", data.borrower.identityNumber],
    ["Customer address", data.borrower.addressLines.join(", ")],
    ["Asset", `${data.asset.description} · ${data.asset.serialNumber}`],
  ])
  w.section("ACCOUNT RESULT")
  w.labelValues([
    ["Settlement due at sale", formatZarPdf(o.settlementDueCents)],
    ["Gross sale proceeds", formatZarPdf(o.grossProceedsCents)],
    ["Costs deducted from proceeds", formatZarPdf(o.deductedCostsCents)],
    ["Net proceeds", formatZarPdf(o.netProceedsCents)],
    ["Costs charged to account", formatZarPdf(o.chargedCostsCents)],
    ["Amount still owing", formatZarPdf(o.shortfallCents)],
    ["Surplus due to customer", formatZarPdf(o.surplusCents)],
  ])
  if (data.costs.length > 0) {
    w.table("COSTS", COST_COLUMNS, data.costs.map((c) => [
      c.label, c.treatment === "DEDUCT_FROM_PROCEEDS" ? "Deducted from proceeds" : "Charged to account", formatZarPdf(c.grossCents),
    ]))
  }
  return w.finish({ reference: data.reference, watermark: false })
}
