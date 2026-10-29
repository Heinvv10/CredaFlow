// Content shared by the deal documents: the letterhead, the party and asset
// particulars, and how a rate is described. Real data only; no legal wording.
import { Prisma } from "@prisma/client"
import { requireNcrNumber } from "@/lib/config/identity-schema"
import { formatZarPdf } from "@/lib/pdf/helpers"
import { ENTITY_TYPE_LABELS } from "../labels"
import { RATE_BASIS_LABELS } from "../deal-labels"
import type { DealDocumentData } from "./deal-document-data"
import { DealDocumentWriter, formatIsoDatePdf } from "./pdf-layout"
import { commissionDisclosure, introducerRow, type CommissionDocument } from "./wording/commission-disclosure"
import type { DocumentDealer } from "./wording/dealer-name"

/** "0.1175" → "11.75%", exact (Decimal), at least two places. */
export function percentPdf(decimal: string): string {
  const percent = new Prisma.Decimal(decimal).mul(100)
  const places = Math.max(2, percent.decimalPlaces())
  return `${percent.toFixed(places)}%`
}

/** How the contract rate is set, with the figures it resolves to today. */
export function rateDescription(p: Pick<DealDocumentData["pricing"], "annualRate" | "rateBasis" | "rateMargin" | "reference">): string {
  if (p.rateBasis === "FIXED") return `Fixed at ${percentPdf(p.annualRate)} a year (nominal)`
  const margin = p.rateMargin ?? "0"
  const sign = new Prisma.Decimal(margin).isNegative() ? "minus" : "plus"
  const label = RATE_BASIS_LABELS[p.rateBasis]
  const reference = p.reference
    ? `${label} of ${percentPdf(p.reference.rate)} effective ${formatIsoDatePdf(p.reference.effectiveDate)}`
    : label
  return `${label} ${sign} ${percentPdf(new Prisma.Decimal(margin).abs().toString())}, linked to ${label} (${reference}): ${percentPdf(p.annualRate)} a year (nominal)`
}

export function lenderLetterhead(w: DealDocumentWriter, data: Pick<DealDocumentData, "lender">): void {
  const l = data.lender
  w.letterhead(l.legalName, [
    `${l.tradingName !== l.legalName ? `Trading as ${l.tradingName} · ` : ""}Registration No ${l.companyRegNumber} · NCR ${l.ncrNumber}`,
    l.registeredOfficeLines.join(", "),
  ])
}

export function lenderRows(data: Pick<DealDocumentData, "lender">): [string, string][] {
  const l = data.lender
  return [
    ["Name", l.legalName],
    ["Registration number", l.companyRegNumber],
    ["NCR registration", requireNcrNumber(l)],
    ["Registered office", l.registeredOfficeLines.join(", ")],
  ]
}

export function entityRows(data: DealDocumentData): [string, string][] {
  const e = data.entity
  const rows: [string, string][] = [
    ["Name", e.legalName],
    ["Type", ENTITY_TYPE_LABELS[e.type]],
    ["Registration number", e.registrationNumber],
  ]
  if (e.tradingName) rows.push(["Trading as", e.tradingName])
  if (e.mastersReference) rows.push(["Master's reference", e.mastersReference])
  if (e.vatNumber) rows.push(["VAT number", e.vatNumber])
  rows.push(["Address", e.addressLines.length > 0 ? e.addressLines.join(", ") : "Not recorded"])
  return rows
}

export function assetSummary(data: DealDocumentData): string {
  const a = data.asset
  return `${a.year} ${a.make} ${a.model}, serial ${a.serialNumber}${a.vin ? `, VIN ${a.vin}` : ""}`
}

export function assetRows(data: Pick<DealDocumentData, "asset">): [string, string][] {
  const a = data.asset
  const rows: [string, string][] = [
    ["Class", a.classLabel],
    ["Make and model", `${a.make} ${a.model}`],
    ["Year", String(a.year)],
    ["Serial / PIN", a.serialNumber],
  ]
  if (a.vin) rows.push(["VIN", a.vin])
  if (a.engineNumber) rows.push(["Engine number", a.engineNumber])
  if (a.registrationNumber) rows.push(["Registration number", a.registrationNumber])
  return rows
}

export function supplierRows(data: Pick<DealDocumentData, "supplier">): [string, string][] {
  const s = data.supplier
  const rows: [string, string][] = [["Supplier", s.name]]
  if (s.registrationNumber) rows.push(["Registration number", s.registrationNumber])
  if (s.vatNumber) rows.push(["VAT number", s.vatNumber])
  return rows
}

/** The debt in one line, for the suretyship and the resolution. */
export function debtSummary(data: DealDocumentData): [string, string][] {
  const p = data.pricing
  return [
    ["Agreement reference", data.reference],
    ["Goods", assetSummary(data)],
    ["Amount financed", formatZarPdf(p.financedAmountCents)],
    ["Total payable", formatZarPdf(p.totalPayableCents)],
    ["Contract rate", rateDescription(p)],
  ]
}

/** The NCA documents' own section for the introducer and its commission, outside the cost-of-credit disclosure. */
export function introducerSection(w: DealDocumentWriter, dealer: DocumentDealer, document: Extract<CommissionDocument, "NCA_AGREEMENT" | "NCA_QUOTATION">): void {
  w.section("COMMISSION TO THE INTRODUCER")
  w.labelValues([introducerRow(dealer)])
  w.paragraph(commissionDisclosure(document))
}
