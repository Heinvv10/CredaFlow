// The end-of-term inspection report of a lease (slice 3, C7/C9): the date and
// condition recorded at the inspection, the meter readings (start of the
// lease against the final reading), each damage item with its assessed
// amount excl. VAT, and the totals. VAT is added on the end-of-term tax
// invoice, not here. Deterministic; DRAFT watermark.
// UNTESTED: legal — the report's wording and fair wear and tear.
import { formatZarPdf, MARGIN } from "@/lib/pdf/helpers"
import { formatIsoDatePdf, type TableColumn } from "../pdf-layout"
import { finishLeaseDocument, leaseRows, openLeaseDocument } from "./lease-docs-parts"
import type { InspectionReading, InspectionReportData, LeaseDocLender } from "./lease-docs-types"

const DAMAGE_COLUMNS: TableColumn[] = [
  { header: "No.", x: MARGIN + 4, width: 24 },
  { header: "Description", x: MARGIN + 34, width: 340 },
  { header: "Amount excl. VAT", x: MARGIN + 380, width: 131, align: "right" },
]

const reading = (r: InspectionReading | null): string =>
  r ? `${r.value.toLocaleString("en-ZA")} ${r.unit === "HOURS" ? "hours" : "km"} on ${formatIsoDatePdf(r.date)}` : "Not recorded"

export async function renderLeaseInspectionReport(data: InspectionReportData, lender: LeaseDocLender): Promise<Buffer> {
  const w = await openLeaseDocument(lender, data, {
    title: "End-of-term inspection report",
    subtitle: `Lease ${data.reference} · inspected ${formatIsoDatePdf(data.inspectedOn)}`,
    dateIso: data.inspectedOn,
  })
  w.section("1. THE LEASE")
  w.labelValues([
    ...leaseRows(data),
    ["End of term", data.origin === "EARLY_TERMINATION" ? "Early termination: the goods are returned" : "Expiry of the term: the goods are returned"],
  ])
  w.section("2. THE INSPECTION")
  w.labelValues([["Inspected on", formatIsoDatePdf(data.inspectedOn)], ["Condition", data.condition]])
  w.section("3. METER READINGS")
  const used = data.startReading && data.finalReading && data.finalReading.value >= data.startReading.value
    ? `${(data.finalReading.value - data.startReading.value).toLocaleString("en-ZA")} ${data.finalReading.unit === "HOURS" ? "hours" : "km"}`
    : "Not available"
  w.labelValues([["Start of the lease", reading(data.startReading)], ["Final reading", reading(data.finalReading)], ["Used over the lease", used]])
  w.table("4. DAMAGE", DAMAGE_COLUMNS, data.damage.length > 0
    ? data.damage.map((d, i) => [String(i + 1), d.description, formatZarPdf(d.amountExclVatCents)])
    : [["", "No damage recorded", ""]])
  const damageTotal = data.damage.reduce((sum, d) => sum + d.amountExclVatCents, 0)
  w.section("5. TOTALS (EXCL. VAT)")
  w.labelValues([
    ["Damage", formatZarPdf(damageTotal)],
    ["Excess usage", data.excessUsageCents === null ? "Not yet invoiced" : formatZarPdf(data.excessUsageCents)],
    ["Total", formatZarPdf(damageTotal + (data.excessUsageCents ?? 0))],
  ])
  w.paragraph("VAT is added on the end-of-term tax invoice. This report is the lessor's record of the inspection and is not itself an invoice.")
  return finishLeaseDocument(w, data)
}
