import { formatDatePdf, formatZarPdf, MARGIN } from "@/lib/pdf/helpers"
import { DealDocumentWriter, formatIsoDatePdf, type TableColumn } from "../pdf-layout"
import type { NcaAssetDocumentData } from "./types"

const COLUMNS: TableColumn[] = [
  { header: "No.", x: MARGIN + 4, width: 24 },
  { header: "Due date", x: MARGIN + 32, width: 90 },
  { header: "Capital", x: MARGIN + 128, width: 80, align: "right" },
  { header: "Interest", x: MARGIN + 214, width: 80, align: "right" },
  { header: "Fees", x: MARGIN + 300, width: 70, align: "right" },
  { header: "Payment", x: MARGIN + 376, width: 90, align: "right" },
]

export async function renderNcaAssetQuote(data: NcaAssetDocumentData): Promise<Buffer> {
  const w = await DealDocumentWriter.create({ title: `NCA Pre-agreement Statement and Quotation ${data.reference}`, documentDate: data.documentDate })
  w.letterhead(data.lender.legalName, [`NCR ${data.lender.ncrNumber}`, ...data.lender.registeredOfficeLines])
  w.title("PRE-AGREEMENT STATEMENT AND QUOTATION", [
    `Asset finance reference ${data.reference} · prepared ${formatDatePdf(data.documentDate)}`,
    "DRAFT legal wording — figures are generated from the proposed agreement",
  ])
  w.section("CREDIT PROVIDER AND CONSUMER")
  w.labelValues([
    ["Credit provider", data.lender.legalName], ["NCR registration", data.lender.ncrNumber],
    ["Consumer", data.borrower.name], ["Identity / registration", data.borrower.identityNumber],
    ["Consumer address", data.borrower.addressLines.join("\n")],
  ])
  const p = data.pricing
  w.section("COST OF CREDIT DISCLOSURE")
  w.labelValues([
    ["Agreement", data.contractType === "FINANCE_LEASE" ? "Finance lease" : "Instalment sale"],
    ["Asset", `${data.asset.description} · ${data.asset.serialNumber}`],
    ["Cash price", formatZarPdf(p.cashPriceCents)], ["Deposit", formatZarPdf(p.depositCents)],
    ["Principal debt", formatZarPdf(p.principalCents)], ["Annual interest rate", `${(Number(p.annualRate) * 100).toFixed(2)}%`],
    ["Initiation fee", formatZarPdf(p.initiationFeeCents)], ["Monthly service fee", formatZarPdf(p.monthlyServiceFeeCents)],
    ["Credit-life premium", formatZarPdf(p.creditLifePremiumCents)], ["Base instalment", formatZarPdf(p.instalmentCents)],
    ["Residual / balloon", formatZarPdf(p.balloonCents)], ["Total interest", formatZarPdf(p.totalInterestCents)],
    ["Total cost of credit", formatZarPdf(p.totalCostOfCreditCents)], ["Total repayable", formatZarPdf(p.totalRepayableCents)],
  ])
  w.table("PROPOSED REPAYMENT SCHEDULE", COLUMNS, data.schedule.map((r) => [
    String(r.installmentNo), formatIsoDatePdf(r.dueDate), formatZarPdf(r.principalCents),
    formatZarPdf(r.interestCents), formatZarPdf(r.feesCents), formatZarPdf(r.totalCents),
  ]))
  w.section("ACKNOWLEDGEMENT")
  w.placeholderClause("1", "Statutory disclosures and validity period")
  w.signatures([{ caption: "Consumer acknowledgement", name: data.borrower.name, detail: "Acknowledges receipt; this is not acceptance of the agreement" }])
  return w.finish({ reference: data.reference, watermark: true })
}
