// The operating-lease and full-maintenance-lease agreements (slice 3, C9).
// Parties, goods, supplier, rental terms, the rental schedule and (FML) the
// maintenance-and-usage annexure are the deal's real data; the terms and
// conditions are the drafted wording in ../wording/lease-agreement.ts, for the
// lender's legal team to approve (Confirmation Gate 6.2). Until TenantConfig.assetFinanceLegalWordingApproved
// every page carries the DRAFT — NOT FOR EXECUTION watermark. Deterministic:
// the same data renders the same bytes, so the sha256 binds what was signed.
// No NCA content: a lease is not a credit agreement (lib/asset-finance/lease-deal.ts).
import { Prisma } from "@prisma/client"
import { formatDatePdf, formatZarPdf, MARGIN } from "@/lib/pdf/helpers"
import type { AnyDealDocumentData } from "../deal-document-data"
import { DealDocumentWriter, formatIsoDatePdf, type TableColumn } from "../pdf-layout"
import { assetRows, lenderLetterhead, lenderRows, percentPdf, rateDescription, supplierRows } from "../document-parts"
import { ENTITY_TYPE_LABELS } from "../../labels"
import { leaseAgreementClauses } from "../wording/lease-agreement"
import type { LeaseDocumentTerms } from "./lease-document-data"

const SCHEDULE_COLUMNS: TableColumn[] = [
  { header: "No.", x: MARGIN + 4, width: 22 },
  { header: "Due date", x: MARGIN + 30, width: 80 },
  { header: "Rental excl. VAT", x: MARGIN + 112, width: 92, align: "right" },
  { header: "Maintenance", x: MARGIN + 210, width: 80, align: "right" },
  { header: "VAT", x: MARGIN + 296, width: 70, align: "right" },
  { header: "Total incl. VAT", x: MARGIN + 372, width: 139, align: "right" },
]

export const LEASE_TITLES: Record<LeaseDocumentTerms["contractType"], string> = {
  OPERATING_LEASE: "OPERATING LEASE AGREEMENT",
  FULL_MAINTENANCE_LEASE: "FULL MAINTENANCE LEASE AGREEMENT",
}

const RISK_MODEL_TEXT = {
  LENDER_RISK: "The lessor keeps any surplus in the maintenance fund and bears any deficit",
  LESSEE_SETTLED: "At the end of the term a surplus is refunded to the lessee and a deficit is invoiced to the lessee",
} as const

function lesseeRows(data: AnyDealDocumentData): [string, string][] {
  if (data.entity === null) {
    const p = data.soleProprietor
    return [
      ["Name", p.name],
      ["Type", "Sole proprietor (natural person)"],
      ["Identity number", p.idNumber],
      ["Address", p.addressLines.length > 0 ? p.addressLines.join(", ") : "Not recorded"],
    ]
  }
  const e = data.entity
  const rows: [string, string][] = [["Name", e.legalName], ["Type", ENTITY_TYPE_LABELS[e.type]], ["Registration number", e.registrationNumber]]
  if (e.tradingName) rows.push(["Trading as", e.tradingName])
  if (e.vatNumber) rows.push(["VAT number", e.vatNumber])
  rows.push(["Address", e.addressLines.length > 0 ? e.addressLines.join(", ") : "Not recorded"])
  return rows
}

const lesseeName = (data: AnyDealDocumentData): string => data.entity?.legalName ?? data.soleProprietor?.name ?? ""

function arrearsText(margin: string | null): string {
  if (margin === null) return "None"
  return new Prisma.Decimal(margin).isZero() ? "Contract rate (no added margin)" : `Contract rate plus ${percentPdf(margin)} a year`
}

function rentalRows(data: AnyDealDocumentData, lease: LeaseDocumentTerms): [string, string][] {
  const p = data.pricing
  const t = lease.terms
  const s = lease.schedule
  return [
    ["Term", `${s.rows.length} months, ${formatIsoDatePdf(p.startDate)} to ${formatIsoDatePdf(lease.endDate)}`],
    ["Rentals", t.rentalTiming === "ADVANCE" ? "Monthly in advance, the first on the commencement date" : "Monthly in arrears"],
    ["Base monthly rental excl. VAT", formatZarPdf(s.baseRentalCents)],
    ["Annual escalation of the rental", percentPdf(t.escalationRate)],
    ["Contract rate (prices the rental)", rateDescription(p)],
    ["VAT", `Charged on every rental at the rate in force (${percentPdf(s.vatRate)} at commencement)`],
    ["Total rentals excl. VAT", formatZarPdf(s.totalRentalExclVatCents)],
    ...(lease.contractType === "FULL_MAINTENANCE_LEASE" ? [["Total maintenance excl. VAT", formatZarPdf(s.totalMaintenanceExclVatCents)] as [string, string]] : []),
    ["Total VAT", formatZarPdf(s.totalVatCents)],
    ["Total payable incl. VAT", formatZarPdf(s.totalCents)],
    ["Early-termination penalty", `${percentPdf(t.earlyTerminationPenaltyRate)} of the present value of the rentals outstanding (clause 9.10)`],
    ["Default interest on arrears", arrearsText(p.arrearsMarginRate)],
    ["Collection fee per missed rental", p.collectionFeeCents > 0 ? formatZarPdf(p.collectionFeeCents) : "None"],
  ]
}

function annexureRows(lease: LeaseDocumentTerms): [string, string][] {
  const { maintenance, usage } = lease.terms
  const rows: [string, string][] = []
  if (maintenance) {
    rows.push(
      ["Monthly maintenance excl. VAT", formatZarPdf(maintenance.monthlyExclVatCents)],
      ["Annual escalation of maintenance", percentPdf(maintenance.escalationRate)],
      ["Maintenance fund", RISK_MODEL_TEXT[maintenance.riskModel]],
    )
  }
  if (usage) {
    const unit = usage.unit === "HOURS" ? "hours" : "km"
    rows.push(
      ["Contracted usage", `${usage.allowancePerYear.toLocaleString("en-ZA")} ${unit} a year`],
      ["Excess-usage charge excl. VAT", `${formatZarPdf(usage.excessRateCents)} per ${unit === "hours" ? "hour" : "km"} above the contracted usage, billed once at the end of the term`],
    )
  }
  return rows
}

function cpaText(lease: LeaseDocumentTerms): string {
  return lease.cpaApplies
    ? "The Consumer Protection Act, 2008 applies to this lease. Its fixed-term rules (section 14) apply: the lessee may cancel on 20 business days' notice, subject to a reasonable cancellation penalty, and is notified before the term expires."
    : "The Consumer Protection Act, 2008 does not apply to this lease: the lessee is a juristic person at or above the threshold (section 5(2)(b))."
}

export async function renderLeaseAgreement(data: AnyDealDocumentData): Promise<Buffer> {
  const lease = data.lease
  if (!lease) throw new RangeError("renderLeaseAgreement: the deal is not a lease")
  const title = LEASE_TITLES[lease.contractType]
  const fml = lease.contractType === "FULL_MAINTENANCE_LEASE"
  const w = await DealDocumentWriter.create({ title: `${title} ${data.reference}`, documentDate: data.documentDate })
  lenderLetterhead(w, data)
  w.title(title, [`Agreement reference ${data.reference} · prepared ${formatDatePdf(data.documentDate)}`])

  w.section("1. THE LESSOR")
  w.labelValues(lenderRows(data))
  w.section("2. THE LESSEE")
  w.labelValues(lesseeRows(data))
  w.section("3. THE GOODS (OWNED BY THE LESSOR THROUGHOUT)")
  w.labelValues(assetRows(data))
  w.section("4. THE SUPPLIER")
  w.labelValues(supplierRows(data))
  w.section("5. RENTALS")
  w.labelValues(rentalRows(data, lease))
  // An operating lease has no maintenance column.
  const keep = (_: unknown, i: number) => fml || i !== 3
  w.table("6. RENTAL SCHEDULE", SCHEDULE_COLUMNS.filter(keep), lease.schedule.rows.map((r) => [
    String(r.periodNo),
    formatIsoDatePdf(r.dueDate),
    formatZarPdf(r.rentalExclVatCents),
    formatZarPdf(r.maintenanceExclVatCents),
    formatZarPdf(r.vatCents),
    formatZarPdf(r.totalCents),
  ].filter(keep)))
  const annexure = annexureRows(lease)
  if (annexure.length > 0) {
    w.section(fml ? "7. ANNEXURE A — MAINTENANCE AND USAGE" : "7. CONTRACTED USAGE")
    w.labelValues(annexure)
  } else {
    w.section("7. CONTRACTED USAGE")
    w.paragraph("No usage limit is contracted.")
  }
  w.section("8. CONSUMER PROTECTION ACT")
  w.paragraph(cpaText(lease))
  w.section("9. TERMS AND CONDITIONS")
  leaseAgreementClauses({
    lessorName: data.lender.legalName, lesseeName: lesseeName(data), fml, cpa: lease.cpaApplies, terms: lease.terms,
    pricing: data.pricing, startDate: data.pricing.startDate, endDate: lease.endDate,
  }).forEach((c, i) => w.clause(`9.${i + 1}`, c.heading, c.text))

  w.section("10. SIGNATURES")
  w.signatures([
    ...data.signatories.map((s) => ({ caption: `For the lessee, ${lesseeName(data)}`, name: s.name, detail: data.entity ? "Authorised signatory" : "Lessee" })),
    { caption: `For the lessor, ${data.lender.legalName}`, name: "Name:", detail: "Authorised signatory" },
  ])
  return w.finish({ reference: data.reference, watermark: !data.legalWordingApproved })
}
