// The instalment sale agreement (goal §4.9). Parties, goods, supplier,
// pricing and the full schedule are the deal's real data; the clauses are
// drafted wording (./wording/instalment-sale.ts) awaiting the lender's legal
// team (Confirmation Gate 6.2). Until TenantConfig.assetFinanceLegalWordingApproved
// every page carries the DRAFT — NOT FOR EXECUTION watermark.
import { Prisma } from "@prisma/client"
import { formatDatePdf, formatZarPdf, MARGIN } from "@/lib/pdf/helpers"
import { PRESET_LABELS } from "../deal-labels"
import { STRUCTURE_PRESETS } from "../deal-input"
import type { DealDocumentData } from "./deal-document-data"
import { DealDocumentWriter, formatIsoDatePdf, type TableColumn } from "./pdf-layout"
import { instalmentSaleClauses } from "./wording/instalment-sale"
import { assetRows, entityRows, lenderLetterhead, lenderRows, percentPdf, rateDescription, supplierRows } from "./document-parts"

const SCHEDULE_COLUMNS: TableColumn[] = [
  { header: "No.", x: MARGIN + 4, width: 22 },
  { header: "Due date", x: MARGIN + 30, width: 80 },
  { header: "Payment", x: MARGIN + 112, width: 72, align: "right" },
  { header: "Interest", x: MARGIN + 190, width: 68, align: "right" },
  { header: "Capital", x: MARGIN + 264, width: 72, align: "right" },
  { header: "Balloon", x: MARGIN + 342, width: 72, align: "right" },
  { header: "Balance", x: MARGIN + 420, width: 91, align: "right" },
]

/** The arrears margin as data: "Contract rate plus 2.00% a year", or none. */
function arrearsMarginDescription(margin: string | null): string {
  if (margin === null) return "None"
  return new Prisma.Decimal(margin).isZero() ? "Contract rate (no added margin)" : `Contract rate plus ${percentPdf(margin)} a year`
}

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
    ["Default interest on arrears", arrearsMarginDescription(p.arrearsMarginRate)],
    ["Collection fee per missed instalment", p.collectionFeeCents > 0 ? formatZarPdf(p.collectionFeeCents) : "None"],
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
  instalmentSaleClauses(data).forEach((c, i) => w.clause(`7.${i + 1}`, c.heading, c.text))

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
