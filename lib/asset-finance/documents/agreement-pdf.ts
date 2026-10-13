// The instalment sale agreement (goal §4.9). Parties, goods, supplier,
// pricing and the full schedule are the deal's real data; every clause is a
// marked placeholder until the lender's legal team supplies the wording
// (Confirmation Gate 6.2). Until TenantConfig.assetFinanceLegalWordingApproved
// every page carries the DRAFT — NOT FOR EXECUTION watermark.
import { formatDatePdf, formatZarPdf, MARGIN } from "@/lib/pdf/helpers"
import { PRESET_LABELS } from "../deal-labels"
import { STRUCTURE_PRESETS } from "../deal-input"
import type { DealDocumentData } from "./deal-document-data"
import { DealDocumentWriter, formatIsoDatePdf, type TableColumn } from "./pdf-layout"
import { assetRows, entityRows, lenderLetterhead, lenderRows, rateDescription, supplierRows } from "./document-parts"

/** Clause topics only. The wording of each is a placeholder for the legal team. */
const CLAUSES = [
  "Sale of the goods and ownership",
  "Delivery, acceptance and risk",
  "Payment",
  "Interest and changes to the contract rate",
  "Commencement and recalculation of the schedule",
  "Insurance of the goods",
  "Use, maintenance and location of the goods",
  "Breach and remedies",
  "Default interest and collection costs",
  "Early settlement",
  "Cession and assignment",
  "Domicilium and notices",
  "General",
]

const SCHEDULE_COLUMNS: TableColumn[] = [
  { header: "No.", x: MARGIN + 4, width: 22 },
  { header: "Due date", x: MARGIN + 30, width: 80 },
  { header: "Payment", x: MARGIN + 112, width: 72, align: "right" },
  { header: "Interest", x: MARGIN + 190, width: 68, align: "right" },
  { header: "Capital", x: MARGIN + 264, width: 72, align: "right" },
  { header: "Balloon", x: MARGIN + 342, width: 72, align: "right" },
  { header: "Balance", x: MARGIN + 420, width: 91, align: "right" },
]

function presetLabel(name: string): string {
  const preset = STRUCTURE_PRESETS.find((p) => p === name)
  return preset ? PRESET_LABELS[preset] : name
}

export async function renderInstalmentSaleAgreement(data: DealDocumentData): Promise<Buffer> {
  const w = await DealDocumentWriter.create({ title: `Instalment Sale Agreement ${data.reference}`, documentDate: data.documentDate })
  const p = data.pricing
  lenderLetterhead(w, data)
  w.title("INSTALMENT SALE AGREEMENT", [
    `Agreement reference ${data.reference} · prepared ${formatDatePdf(data.documentDate)}`,
  ])

  w.section("1. THE SELLER (CREDIT PROVIDER)")
  w.labelValues(lenderRows(data))
  w.section("2. THE PURCHASER")
  w.labelValues(entityRows(data))
  w.section("3. THE GOODS")
  w.labelValues(assetRows(data))
  w.section("4. THE SUPPLIER")
  w.labelValues(supplierRows(data))

  w.section("5. PRICE AND FINANCE")
  w.labelValues([
    ["Cash price excl. VAT", formatZarPdf(p.cashPriceExclVatCents)],
    ["VAT", formatZarPdf(p.vatCents)],
    ["Cash price incl. VAT", formatZarPdf(p.cashPriceExclVatCents + p.vatCents)],
    ["Deposit", formatZarPdf(p.depositCents)],
    ["Trade-in", formatZarPdf(p.tradeInCents)],
    ["Fees financed", formatZarPdf(p.financedFeesCents)],
    ["Amount financed", formatZarPdf(p.financedAmountCents)],
    ["Balloon (final payment)", formatZarPdf(p.balloonCents)],
    ["Contract rate", rateDescription(p)],
    ["Interest", "Accrues daily (actual/365) on the reducing balance"],
    ["Repayment structure", `${presetLabel(p.structurePreset)}, ${data.schedule.length} payments`],
    ["Base instalment", formatZarPdf(p.baseInstalmentCents)],
    ["Total interest", formatZarPdf(p.totalInterestCents)],
    ["Total payable", formatZarPdf(p.totalPayableCents)],
    ["Schedule start date", formatIsoDatePdf(p.startDate)],
  ])

  w.table(
    "6. REPAYMENT SCHEDULE",
    SCHEDULE_COLUMNS,
    data.schedule.map((r) => [
      String(r.index + 1),
      formatIsoDatePdf(r.dueDate),
      formatZarPdf(r.totalCents),
      formatZarPdf(r.interestCents),
      formatZarPdf(r.principalCents),
      r.balloonCents > 0 ? formatZarPdf(r.balloonCents) : "",
      formatZarPdf(r.closingBalanceCents),
    ]),
  )

  w.section("7. TERMS AND CONDITIONS")
  CLAUSES.forEach((heading, i) => w.placeholderClause(`7.${i + 1}`, heading))

  w.section("8. SIGNATURES")
  w.signatures([
    ...data.signatories.map((s) => ({
      caption: `For the purchaser, ${data.entity.legalName}`,
      name: s.name,
      detail: "Authorised signatory",
    })),
    { caption: `For the seller, ${data.lender.legalName}`, name: "Name:", detail: "Authorised signatory" },
  ])
  return w.finish({ reference: data.reference, watermark: !data.legalWordingApproved })
}
